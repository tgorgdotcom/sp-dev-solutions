﻿import * as React from 'react';
import * as ReactDom from 'react-dom';
import { Version, Text, Environment, EnvironmentType, DisplayMode } from '@microsoft/sp-core-library';
import {
    BaseClientSideWebPart,
    IPropertyPaneConfiguration,
    PropertyPaneTextField,
    IWebPartPropertiesMetadata,
    PropertyPaneDynamicFieldSet,
    PropertyPaneDynamicField,
    DynamicDataSharedDepth,
    IPropertyPaneConditionalGroup,
    IPropertyPaneField,
    PropertyPaneToggle,
    PropertyPaneSlider,
    IPropertyPaneChoiceGroupOption,
    PropertyPaneChoiceGroup,
    PropertyPaneCheckbox,
    PropertyPaneHorizontalRule,
    PropertyPaneDropdown,
} from '@microsoft/sp-webpart-base';
import * as strings from 'SearchResultsWebPartStrings';
import SearchResultsContainer from './components/SearchResultsContainer/SearchResultsContainer';
import { ISearchResultsWebPartProps } from './ISearchResultsWebPartProps';
import BaseTemplateService from '../../services/TemplateService/BaseTemplateService';
import ISearchService from '../../services/SearchService/ISearchService';
import ITaxonomyService from '../../services/TaxonomyService/ITaxonomyService';
import ResultsLayoutOption from '../../models/ResultsLayoutOption';
import TemplateService from '../../services/TemplateService/TemplateService';
import { isEmpty, find, sortBy } from '@microsoft/sp-lodash-subset';
import MockSearchService from '../../services/SearchService/MockSearchService';
import MockTemplateService from '../../services/TemplateService/MockTemplateService';
import SearchService from '../../services/SearchService/SearchService';
import TaxonomyService from '../../services/TaxonomyService/TaxonomyService';
import MockTaxonomyService from '../../services/TaxonomyService/MockTaxonomyService';
import ISearchResultsContainerProps from './components/SearchResultsContainer/ISearchResultsContainerProps';
import { Placeholder, IPlaceholderProps } from '@pnp/spfx-controls-react/lib/Placeholder';
import { PropertyFieldCollectionData, CustomCollectionFieldType } from '@pnp/spfx-property-controls/lib/PropertyFieldCollectionData';
import { SortDirection, Sort } from '@pnp/sp';
import { ISortFieldConfiguration, ISortFieldDirection } from '../../models/ISortFieldConfiguration';
import { ISynonymFieldConfiguration } from '../../models/ISynonymFieldConfiguration';
import { ResultTypeOperator } from '../../models/ISearchResultType';
import IResultService from '../../services/ResultService/IResultService';
import { ResultService, IRenderer } from '../../services/ResultService/ResultService';
import { IDynamicDataCallables, IDynamicDataPropertyDefinition } from '@microsoft/sp-dynamic-data';
import { IRefinementFilter, ISearchVerticalInformation } from '../../models/ISearchResult';
import IDynamicDataService from '../../services/DynamicDataService/IDynamicDataService';
import { DynamicDataService } from '../../services/DynamicDataService/DynamicDataService';
import { DynamicProperty } from '@microsoft/sp-component-base';
import IRefinerSourceData from '../../models/IRefinerSourceData';
import IRefinerConfiguration from '../../models/IRefinerConfiguration';
import { SearchComponentType } from '../../models/SearchComponentType';
import ISearchResultSourceData from '../../models/ISearchResultSourceData';
import IPaginationSourceData from '../../models/IPaginationSourceData';
import ISynonymTable from '../../models/ISynonym';
import * as update from 'immutability-helper';
import ISearchVerticalSourceData from '../../models/ISearchVerticalSourceData';
import { ISearchVertical } from '../../models/ISearchVertical';

export default class SearchResultsWebPart extends BaseClientSideWebPart<ISearchResultsWebPartProps> implements IDynamicDataCallables {

    private _searchService: ISearchService;
    private _taxonomyService: ITaxonomyService;
    private _templateService: BaseTemplateService;
    private _textDialogComponent = null;
    private _propertyFieldCodeEditor = null;
    private _propertyFieldCodeEditorLanguages = null;
    private _resultService: IResultService;

    // Dynamic data related fields
    private _dynamicDataService: IDynamicDataService;

    private _refinerSourceData: DynamicProperty<IRefinerSourceData>;
    private _searchVerticalSourceData: DynamicProperty<ISearchVerticalSourceData>;
    private _paginationSourceData: DynamicProperty<IPaginationSourceData>;
    private _verticalsInformation: ISearchVerticalInformation[];

    private _codeRenderers: IRenderer[];
    private _searchContainer: JSX.Element;
    private _synonymTable: ISynonymTable;

    /**
     * The template to display at render time
     */
    private _templateContentToDisplay: string;

    public constructor() {
        super();
        this._templateContentToDisplay = '';
    }

    public async render(): Promise<void> {
        // Determine the template content to display
        // In the case of an external template is selected, the render is done asynchronously waiting for the content to be fetched
        await this._getTemplateContent();

        this.renderCompleted();
    }

    protected get disableReactivePropertyChanges(): boolean {
        // Set this to true if you don't want the reactive behavior.
        return false;
    }

    protected get isRenderAsync(): boolean {
        return true;
    }

    protected renderCompleted(): void {
        super.renderCompleted();
        let renderElement = null;
        let refinerConfiguration: IRefinerConfiguration[] = [];
        let selectedFilters: IRefinementFilter[] = [];
        let selectedPage: number = 1;
        let queryTemplate: string = this.properties.queryTemplate;
        let sourceId: string = this.properties.resultSourceId;
        let getVerticalsCounts: boolean = false;

        let queryDataSourceValue = this._dynamicDataService.getDataSourceValue(this.properties.queryKeywords, this.properties.sourceId, this.properties.propertyId, this.properties.propertyPath);
        if (typeof (queryDataSourceValue) !== 'string') {
            queryDataSourceValue = '';
            this.context.propertyPane.refresh();
        }

        let queryKeywords = (!queryDataSourceValue) ? this.properties.defaultSearchQuery : queryDataSourceValue;

        // Get data from connected sources
        if (this._refinerSourceData) {
            const refinerSourceData: IRefinerSourceData = this._refinerSourceData.tryGetValue();
            if (refinerSourceData) {
                refinerConfiguration = sortBy(refinerSourceData.refinerConfiguration, 'sortIdx');
                selectedFilters = refinerSourceData.selectedFilters;
                this._searchService = update(this._searchService, {refinementFilters: { $set: selectedFilters }, refiners: { $set: refinerConfiguration }});
            }
        }

        if (this._searchVerticalSourceData) {
            const searchVerticalSourceData: ISearchVerticalSourceData = this._searchVerticalSourceData.tryGetValue();
            if (searchVerticalSourceData) {
                if (searchVerticalSourceData.selectedVertical) {
                    queryTemplate = searchVerticalSourceData.selectedVertical.queryTemplate;
                    sourceId = searchVerticalSourceData.selectedVertical.resultSourceId;
                    getVerticalsCounts = searchVerticalSourceData.showCounts;
                }
            }
        }

        if (this._paginationSourceData) {
            const paginationSourceData: IPaginationSourceData = this._paginationSourceData.tryGetValue();
            if (paginationSourceData) {
                selectedPage = paginationSourceData.selectedPage;
            }
        }

        // Configure the provider before the query according to our needs
        this._searchService = update(this._searchService, {
            resultsCount: { $set: this.properties.maxResultsCount },
            queryTemplate: { $set: queryTemplate },
            resultSourceId: { $set: sourceId },
            sortList: { $set: this._convertToSortList(this.properties.sortList) },
            enableQueryRules: { $set: this.properties.enableQueryRules },
            selectedProperties: { $set: this.properties.selectedProperties ? this.properties.selectedProperties.replace(/\s|,+$/g, '').split(',') : [] },                  
            synonymTable: { $set: this._synonymTable }
        });

        const isValueConnected = !!this.properties.queryKeywords.tryGetSource();
        this._searchContainer = React.createElement(
            SearchResultsContainer,
            {
                searchService: this._searchService,
                taxonomyService: this._taxonomyService,
                queryKeywords: queryKeywords,
                sortableFields: this.properties.sortableFields,
                showPaging: this.properties.showPaging,
                showResultsCount: this.properties.showResultsCount,
                showBlank: this.properties.showBlank,
                displayMode: this.displayMode,
                templateService: this._templateService,
                templateContent: this._templateContentToDisplay,
                webPartTitle: this.properties.webPartTitle,
                currentUICultureName: this.context.pageContext.cultureInfo.currentUICultureName,
                siteServerRelativeUrl: this.context.pageContext.site.serverRelativeUrl,
                webServerRelativeUrl: this.context.pageContext.web.serverRelativeUrl,
                resultTypes: this.properties.resultTypes,
                useCodeRenderer: this.codeRendererIsSelected(),
                customTemplateFieldValues: this.properties.customTemplateFieldValues,
                rendererId: this.properties.selectedLayout as any,
                enableLocalization: this.properties.enableLocalization,
                selectedPage: selectedPage,
                onSearchResultsUpdate: async (results, mountingNodeId, searchService) => {
                    if (this.properties.selectedLayout in ResultsLayoutOption) {
                        let node = document.getElementById(mountingNodeId);
                        if (node) {
                            ReactDom.render(null, node);
                        }
                    }

                    if (getVerticalsCounts) {

                        const searchVerticalSourceData: ISearchVerticalSourceData = this._searchVerticalSourceData.tryGetValue();
                        const otherVerticals = searchVerticalSourceData.verticalsConfiguration.filter(v => { return v.key !== searchVerticalSourceData.selectedVertical.key;});
                        searchService.getSearchVerticalCounts(queryKeywords, otherVerticals, searchService.enableQueryRules).then((verticalsInfos) => {

                            let currentCount = results.PaginationInformation ? results.PaginationInformation.TotalRows : undefined;

                            if (currentCount !== undefined && currentCount !== null) {
                                // Add current vertical infos
                                let currentVerticalInfos: ISearchVerticalInformation = {
                                    Count: currentCount,
                                    VerticalKey: searchVerticalSourceData.selectedVertical.key
                                };

                                verticalsInfos.push(currentVerticalInfos);
                            }    
    
                            this._verticalsInformation = update(this._verticalsInformation , {$set : verticalsInfos});
                            this.context.dynamicDataSourceManager.notifyPropertyChanged(SearchComponentType.SearchResultsWebPart);
                        });
                    }

                    this._resultService.updateResultData(results, this.properties.selectedLayout as any, mountingNodeId, this.properties.customTemplateFieldValues);

                    // Send notification to the connected components
                    this.context.dynamicDataSourceManager.notifyPropertyChanged(SearchComponentType.SearchResultsWebPart);
                }
            } as ISearchResultsContainerProps
        );

        const placeholder: React.ReactElement<IPlaceholderProps> = React.createElement(
            Placeholder,
            {
                iconName: strings.PlaceHolderEditLabel,
                iconText: strings.PlaceHolderIconText,
                description: strings.PlaceHolderDescription,
                buttonLabel: strings.PlaceHolderConfigureBtnLabel,
                onConfigure: this._setupWebPart.bind(this)
            }
        );

        if (isValueConnected && !this.properties.useDefaultSearchQuery ||
            isValueConnected && this.properties.useDefaultSearchQuery && this.properties.defaultSearchQuery ||
            !isValueConnected && !isEmpty(queryKeywords)) {
            renderElement = this._searchContainer;
        } else {
            if (this.displayMode === DisplayMode.Edit) {
                renderElement = placeholder;
            } else {
                renderElement = React.createElement('div', null);
            }
        }

        ReactDom.render(renderElement, this.domElement);
    }

    protected async onInit(): Promise<void> {

        this.initializeRequiredProperties();

        if (Environment.type === EnvironmentType.Local) {
            this._taxonomyService = new MockTaxonomyService();
            this._templateService = new MockTemplateService(this.context.pageContext.cultureInfo.currentUICultureName);
            this._searchService = new MockSearchService();

        } else {
            this._taxonomyService = new TaxonomyService(this.context.pageContext.site.absoluteUrl);
            this._templateService = new TemplateService(this.context.spHttpClient, this.context.pageContext.cultureInfo.currentUICultureName);
            this._searchService = new SearchService(this.context.pageContext, this.context.spHttpClient);
        }

        this._resultService = new ResultService();
        this._codeRenderers = this._resultService.getRegisteredRenderers();
        this._dynamicDataService = new DynamicDataService(this.context.dynamicDataProvider);
        this._verticalsInformation= [];

        this.ensureDataSourceConnection();

        if (this.properties.sourceId) {
            // Needed to retrieve manually the value for the dynamic property at render time. See the associated SPFx bug
            // https://github.com/SharePoint/sp-dev-docs/issues/2985
            this.context.dynamicDataProvider.registerAvailableSourcesChanged(this.render);
        }

        // Set the default search results layout
        this.properties.selectedLayout = this.properties.selectedLayout ? this.properties.selectedLayout : ResultsLayoutOption.List;

        this.context.dynamicDataSourceManager.initializeSource(this);
        this._synonymTable = this._convertToSynonymTable(this.properties.synonymList);

        return super.onInit();
    }

    private _convertToSortConfig(sortList: string): ISortFieldConfiguration[] {
        let pairs = sortList.split(',');
        return pairs.map(sort => {
            let direction;
            let kvp = sort.split(':');
            if (kvp[1].toLocaleLowerCase().trim() === "ascending") {
                direction = ISortFieldDirection.Ascending;
            } else {
                direction = ISortFieldDirection.Descending;
            }

            return {
                sortField: kvp[0].trim(),
                sortDirection: direction
            } as ISortFieldConfiguration;
        });
    }

    private _convertToSynonymTable(synonymList: ISynonymFieldConfiguration[]): ISynonymTable {
        let synonymsTable: ISynonymTable = {};

        if (synonymList)
        {
            synonymList.forEach(item => {
                const currentTerm = item.Term.toLowerCase();
                const currentSynonyms = this._splitSynonyms(item.Synonyms);
    
                //add to array
                synonymsTable[currentTerm] = currentSynonyms;
    
                if (item.TwoWays) {
                    // Loop over the list of synonyms
                    let tempSynonyms: string[] = currentSynonyms;
                    tempSynonyms.push(currentTerm.trim());
    
                    currentSynonyms.forEach(s => {
                        synonymsTable[s.toLowerCase().trim()] = tempSynonyms.filter(f => { return f !== s; });
                    });
                }
            });
        }
        return synonymsTable;
    }

    private _splitSynonyms(value: string) {
        return value.split(",").map(v => { return v.toLowerCase().trim().replace(/\"/g, ""); });
    }

    private _convertToSortList(sortList: ISortFieldConfiguration[]): Sort[] {
        return sortList.map(e => {

            let direction;

            switch (e.sortDirection) {
                case ISortFieldDirection.Ascending:
                    direction = SortDirection.Ascending;
                    break;

                case ISortFieldDirection.Descending:
                    direction = SortDirection.Descending;
                    break;

                default:
                    direction = SortDirection.Ascending;
                    break;
            }

            return {
                Property: e.sortField,
                Direction: direction
            } as Sort;
        });
    }

    protected onDispose(): void {
        ReactDom.unmountComponentAtNode(this.domElement);
    }

    protected get dataVersion(): Version {
        return Version.parse('1.0');
    }

    /**
     * Initializes the Web Part required properties if there are not present in the manifest (i.e. during an update scenario)
     */
    private initializeRequiredProperties() {

        this.properties.queryTemplate = this.properties.queryTemplate ? this.properties.queryTemplate : "{searchTerms} Path:{Site}";

        if (!Array.isArray(this.properties.sortList) && !isEmpty(this.properties.sortList)) {
            this.properties.sortList = this._convertToSortConfig(this.properties.sortList);
        }

        this.properties.sortList = Array.isArray(this.properties.sortList) ? this.properties.sortList : [
            {
                sortField: "Created",
                sortDirection: ISortFieldDirection.Ascending
            },
            {
                sortField: "Size",
                sortDirection: ISortFieldDirection.Descending
            }
        ];

        this.properties.sortableFields = Array.isArray(this.properties.sortableFields) ? this.properties.sortableFields : [];
        this.properties.selectedProperties = this.properties.selectedProperties ? this.properties.selectedProperties : "Title,Path,Created,Filename,SiteLogo,PreviewUrl,PictureThumbnailURL,ServerRedirectedPreviewURL,ServerRedirectedURL,HitHighlightedSummary,FileType,contentclass,ServerRedirectedEmbedURL,DefaultEncodingURL,owstaxidmetadataalltagsinfo";
        this.properties.maxResultsCount = this.properties.maxResultsCount ? this.properties.maxResultsCount : 10;
        this.properties.resultTypes = Array.isArray(this.properties.resultTypes) ? this.properties.resultTypes : [];
        this.properties.synonymList = Array.isArray(this.properties.synonymList) ? this.properties.synonymList : [];
    }

    protected getPropertyPaneConfiguration(): IPropertyPaneConfiguration {

        return {
            pages: [
                {
                    header: {
                        description: strings.SearchQuerySettingsGroupName
                    },
                    groups: [
                        this._getSearchQueryFields()
                    ]
                },
                {
                    header: {
                        description: strings.SearchSettingsGroupName
                    },
                    groups: [
                        {
                            groupFields: this._getSearchSettingsFields()
                        }
                    ]
                },
                {
                    header: {
                        description: strings.StylingSettingsGroupName
                    },
                    groups: [
                        {
                            groupFields: this._getStylingFields()
                        }
                    ]
                }
            ]
        };
    }

    protected get propertiesMetadata(): IWebPartPropertiesMetadata {
        return {
            'queryKeywords': {
                dynamicPropertyType: 'string'
            }
        };
    }

    protected async loadPropertyPaneResources(): Promise<void> {

        // Code editor component for result types
        this._textDialogComponent = await import(
            /* webpackChunkName: 'search-property-pane' */
            '../controls/TextDialog'
        );

        // tslint:disable-next-line:no-shadowed-variable
        const { PropertyFieldCodeEditor, PropertyFieldCodeEditorLanguages } = await import(
            /* webpackChunkName: 'search-property-pane' */
            '@pnp/spfx-property-controls/lib/PropertyFieldCodeEditor'
        );

        this._propertyFieldCodeEditor = PropertyFieldCodeEditor;
        this._propertyFieldCodeEditorLanguages = PropertyFieldCodeEditorLanguages;
    }

    protected async onPropertyPaneFieldChanged(propertyPath: string) {

        if (propertyPath.localeCompare('queryKeywords') === 0) {

            // Update data source information
            this._saveDataSourceInfo();
        }

        if (!this.properties.useDefaultSearchQuery) {
            this.properties.defaultSearchQuery = '';
        }

        // Bind connected data sources
        if (this.properties.refinerDataSourceReference || this.properties.paginationDataSourceReference || this.properties.searchVerticalDataSourceReference) {
            this.ensureDataSourceConnection();
        }

        if (propertyPath.localeCompare('useRefiners') === 0) {
            if (!this.properties.useRefiners) {
                this.properties.refinerDataSourceReference = undefined;
                this._refinerSourceData = undefined;
                this.context.dynamicDataSourceManager.notifyPropertyChanged(SearchComponentType.SearchResultsWebPart);
            }
        }

        if (propertyPath.localeCompare('useSearchVerticals') === 0) {

            if (!this.properties.useSearchVerticals) {
                this.properties.searchVerticalDataSourceReference = undefined;
                this._searchVerticalSourceData = undefined;
                this._verticalsInformation= [];
                this.context.dynamicDataSourceManager.notifyPropertyChanged(SearchComponentType.SearchResultsWebPart);
            }
        }

        if (propertyPath.localeCompare('searchVerticalDataSourceReference') === 0 || propertyPath.localeCompare('refinerDataSourceReference')) {
            this.context.dynamicDataSourceManager.notifyPropertyChanged(SearchComponentType.SearchResultsWebPart);
        }

        if (!this.properties.showPaging) {
            this.properties.paginationDataSourceReference = undefined;
            this._paginationSourceData = undefined;
        }

        if (this.properties.enableLocalization) {

            let udpatedProperties: string[] = this.properties.selectedProperties.split(',');
            if (udpatedProperties.indexOf('UniqueID') === -1) {
                udpatedProperties.push('UniqueID');
            }

            // Add automatically the UniqueID managed property for subsequent queries
            this.properties.selectedProperties = udpatedProperties.join(',');
        }

        if (propertyPath.localeCompare('selectedLayout') === 0) {
            // Refresh setting the right template for the property pane
            if (!this.codeRendererIsSelected()) {
                await this._getTemplateContent();
            }
            if (this.codeRendererIsSelected) {
                this.properties.customTemplateFieldValues = undefined;
            }

            this.context.propertyPane.refresh();
        }

        // Detect if the layout has been changed to custom...
        if (propertyPath.localeCompare('inlineTemplateText') === 0) {

            // Automatically switch the option to 'Custom' if a default template has been edited
            // (meaning the user started from a the list or tiles template)
            if (this.properties.inlineTemplateText && this.properties.selectedLayout !== ResultsLayoutOption.Custom) {
                this.properties.selectedLayout = ResultsLayoutOption.Custom;

                // Reset also the template URL
                this.properties.externalTemplateUrl = '';
            }
        }

        this._synonymTable = this._convertToSynonymTable(this.properties.synonymList);
    }

    protected async onPropertyPaneConfigurationStart() {
        await this.loadPropertyPaneResources();
    }

    /**
    * Save the useful information for the connected data source. 
    * They will be used to get the value of the dynamic property if this one fails.
    */
    private _saveDataSourceInfo() {

        if (this.properties.queryKeywords.tryGetSource()) {
            this.properties.sourceId = this.properties.queryKeywords["_reference"]._sourceId;
            this.properties.propertyId = this.properties.queryKeywords["_reference"]._property;
            this.properties.propertyPath = this.properties.queryKeywords["_reference"]._propertyPath;
        } else {
            this.properties.sourceId = null;
            this.properties.propertyId = null;
            this.properties.propertyPath = null;
        }
    }

    /**
     * Opens the Web Part property pane
     */
    private _setupWebPart() {
        this.context.propertyPane.open();
    }

    /**
     * Checks if a field if empty or not
     * @param value the value to check
     */
    private _validateEmptyField(value: string): string {

        if (!value) {
            return strings.EmptyFieldErrorMessage;
        }

        return '';
    }

    /**
     * Ensures the result source id value is a valid GUID
     * @param value the result source id
     */
    private validateSourceId(value: string): string {
        if (value.length > 0) {
            if (!/^(\{){0,1}[0-9a-fA-F]{8}\-[0-9a-fA-F]{4}\-[0-9a-fA-F]{4}\-[0-9a-fA-F]{4}\-[0-9a-fA-F]{12}(\}){0,1}$/.test(value)) {
                return strings.InvalidResultSourceIdMessage;
            }
        }

        return '';
    }

    /**
     * Get the correct results template content according to the property pane current configuration
     * @returns the template content as a string
     */
    private async _getTemplateContent(): Promise<void> {

        let templateContent = null;

        switch (this.properties.selectedLayout) {
            case ResultsLayoutOption.List:
                templateContent = TemplateService.getListDefaultTemplate();
                break;

            case ResultsLayoutOption.Tiles:
                templateContent = TemplateService.getTilesDefaultTemplate();
                break;

            case ResultsLayoutOption.Custom:

                if (this.properties.externalTemplateUrl) {
                    templateContent = await this._templateService.getFileContent(this.properties.externalTemplateUrl);
                } else {
                    templateContent = this.properties.inlineTemplateText ? this.properties.inlineTemplateText : TemplateService.getBlankDefaultTemplate();
                }

                break;

            default:
                break;
        }

        // Register result types inside the template      
        this._templateService.registerResultTypes(this.properties.resultTypes);

        this._templateContentToDisplay = templateContent;
    }

    /**
     * Custom handler when the external template file URL
     * @param value the template file URL value
     */
    private async _onTemplateUrlChange(value: string): Promise<String> {

        try {
            // Doesn't raise any error if file is empty (otherwise error message will show on initial load...)
            if (isEmpty(value)) {
                return '';
            }
            // Resolves an error if the file isn't a valid .htm or .html file
            else if (!TemplateService.isValidTemplateFile(value)) {
                return strings.ErrorTemplateExtension;
            }
            // Resolves an error if the file doesn't answer a simple head request
            else {
                await this._templateService.ensureFileResolves(value);
                return '';
            }
        } catch (error) {
            return Text.format(strings.ErrorTemplateResolve, error);
        }
    }

    /**
     * Determines the group fields for the search settings options inside the property pane
     */
    private _getSearchSettingsFields(): IPropertyPaneField<any>[] {

        // Get available data source Web Parts on the page
        const refinerWebParts = this._dynamicDataService.getAvailableDataSourcesByType(SearchComponentType.RefinersWebPart);
        const searchVerticalsWebParts = this._dynamicDataService.getAvailableDataSourcesByType(SearchComponentType.SearchVerticalsWebPart);

        let useRefiners = this.properties.useRefiners;
        let useSearchVerticals = this.properties.useSearchVerticals;

        if (this.properties.useRefiners && refinerWebParts.length === 0) {
            useRefiners = false;
        }

        if (this.properties.useSearchVerticals && searchVerticalsWebParts.length === 0) {
            useSearchVerticals = false;
        }

        // Sets up search settings fields
        const searchSettingsFields: IPropertyPaneField<any>[] = [
            PropertyPaneTextField('queryTemplate', {
                label: strings.QueryTemplateFieldLabel,
                value: this.properties.queryTemplate,
                disabled: this.properties.searchVerticalDataSourceReference ? true : false,
                multiline: true,
                resizable: true,
                placeholder: strings.SearchQueryPlaceHolderText,
                deferredValidationTime: 300
            }),
            PropertyPaneTextField('resultSourceId', {
                label: strings.ResultSourceIdLabel,
                multiline: false,
                onGetErrorMessage: this.validateSourceId.bind(this),
                deferredValidationTime: 300
            }),
            PropertyFieldCollectionData('sortList', {
                manageBtnLabel: strings.Sort.EditSortLabel,
                key: 'sortList',
                enableSorting: true,
                panelHeader: strings.Sort.EditSortLabel,
                panelDescription: strings.Sort.SortListDescription,
                label: strings.Sort.SortPropertyPaneFieldLabel,
                value: this.properties.sortList,
                fields: [
                    {
                        id: 'sortField',
                        title: "Field name",
                        type: CustomCollectionFieldType.string,
                        required: true,
                        placeholder: '\"Created\", \"Size\", etc.'
                    },
                    {
                        id: 'sortDirection',
                        title: "Direction",
                        type: CustomCollectionFieldType.dropdown,
                        required: true,
                        options: [
                            {
                                key: ISortFieldDirection.Ascending,
                                text: strings.Sort.SortDirectionAscendingLabel
                            },
                            {
                                key: ISortFieldDirection.Descending,
                                text: strings.Sort.SortDirectionDescendingLabel
                            }
                        ]
                    }
                ]
            }),
            PropertyFieldCollectionData('sortableFields', {
                manageBtnLabel: strings.Sort.EditSortableFieldsLabel,
                key: 'sortableFields',
                enableSorting: true,
                panelHeader: strings.Sort.EditSortableFieldsLabel,
                panelDescription: strings.Sort.SortableFieldsDescription,
                label: strings.Sort.SortableFieldsPropertyPaneField,
                value: this.properties.sortableFields,
                fields: [
                    {
                        id: 'sortField',
                        title: strings.Sort.SortableFieldManagedPropertyField,
                        type: CustomCollectionFieldType.string,
                        placeholder: '\"Created\", \"Size\", etc.',
                        required: true
                    },
                    {
                        id: 'displayValue',
                        title: strings.Sort.SortableFieldDisplayValueField,
                        type: CustomCollectionFieldType.string
                    }
                ]
            }),
            PropertyPaneToggle('useRefiners', {
                label: strings.UseRefinersWebPartLabel,
                checked: useRefiners
            }),
            PropertyPaneToggle('useSearchVerticals', {
                label: "Connect to search verticals",
                checked: useSearchVerticals
            }),
            PropertyPaneToggle('enableQueryRules', {
                label: strings.EnableQueryRulesLabel,
                checked: this.properties.enableQueryRules,
            }),
            PropertyPaneTextField('selectedProperties', {
                label: strings.SelectedPropertiesFieldLabel,
                description: strings.SelectedPropertiesFieldDescription,
                multiline: true,
                resizable: true,
                value: this.properties.selectedProperties,
                deferredValidationTime: 300
            }),
            PropertyPaneSlider('maxResultsCount', {
                label: strings.MaxResultsCount,
                max: 50,
                min: 1,
                showValue: true,
                step: 1,
                value: 50,
            }),
            PropertyPaneToggle('enableLocalization', {
                checked: this.properties.enableLocalization,
                label: strings.EnableLocalizationLabel,
                onText: strings.EnableLocalizationOnLabel,
                offText: strings.EnableLocalizationOffLabel
            }),
            PropertyFieldCollectionData('synonymList', {
                manageBtnLabel: strings.Synonyms.EditSynonymLabel,
                key: 'synonymList',
                enableSorting: false,
                panelHeader: strings.Synonyms.EditSynonymLabel,
                panelDescription: strings.Synonyms.SynonymListDescription,
                label: strings.Synonyms.SynonymPropertyPanelFieldLabel,
                value: this.properties.synonymList,
                fields: [
                    {
                        id: 'Term',
                        title: strings.Synonyms.SynonymListTerm,
                        type: CustomCollectionFieldType.string,
                        required: true,
                        placeholder: strings.Synonyms.SynonymListTermExemple
                    },
                    {
                        id: 'Synonyms',
                        title: strings.Synonyms.SynonymListSynonyms,
                        type: CustomCollectionFieldType.string,
                        required: true,
                        placeholder: strings.Synonyms.SynonymListSynonymsExemple 
                    },
                    {
                        id: 'TwoWays',
                        title: strings.Synonyms.SynonymIsTwoWays,
                        type: CustomCollectionFieldType.boolean,
                        required: false
                    }
                ]
            })
        ];

        // Conditional fields for data sources
        if (this.properties.useRefiners) {

            searchSettingsFields.splice(5, 0,
                PropertyPaneDropdown('refinerDataSourceReference', {
                    options: this._dynamicDataService.getAvailableDataSourcesByType(SearchComponentType.RefinersWebPart),
                    label: strings.UseRefinersFromComponentLabel
                }));
        }

        if (this.properties.useSearchVerticals) {
            searchSettingsFields.splice(this.properties.useRefiners ? 7 : 6, 0,
                PropertyPaneDropdown('searchVerticalDataSourceReference', {
                    options: this._dynamicDataService.getAvailableDataSourcesByType(SearchComponentType.SearchVerticalsWebPart),
                    label: "Use verticals from this component"
                }));
        }

        return searchSettingsFields;
    }

    /**
     * Make sure the dynamic property is correctly connected to the source if a search refiner component has been selected in options 
     */
    private ensureDataSourceConnection() {

        // Refiner Web Part data source
        if (this.properties.refinerDataSourceReference) {

            if (!this._refinerSourceData) {
                this._refinerSourceData = new DynamicProperty<IRefinerSourceData>(this.context.dynamicDataProvider);
            }

            // Register the data source manually since we don't want user select properties manually
            this._refinerSourceData.setReference(this.properties.refinerDataSourceReference);
            this._refinerSourceData.register(this.render);

        } else {

            if (this._refinerSourceData) {
                this._refinerSourceData.unregister(this.render);
            }
        }

        // Search verticals Web Part data source
        if (this.properties.searchVerticalDataSourceReference) {

            if (!this._searchVerticalSourceData) {
                this._searchVerticalSourceData = new DynamicProperty<ISearchVerticalSourceData>(this.context.dynamicDataProvider);
            }

            // Register the data source manually since we don't want user select properties manually
            this._searchVerticalSourceData.setReference(this.properties.searchVerticalDataSourceReference);
            this._searchVerticalSourceData.register(this.render);

        } else {

            if (this._searchVerticalSourceData) {
                this._searchVerticalSourceData.unregister(this.render);
            }
        }

        // Pagination Web Part data source
        if (this.properties.paginationDataSourceReference) {

            if (!this._paginationSourceData) {
                this._paginationSourceData = new DynamicProperty<IPaginationSourceData>(this.context.dynamicDataProvider);
            }

            // Register the data source manually since we don't want user select properties manually
            this._paginationSourceData.setReference(this.properties.paginationDataSourceReference);
            this._paginationSourceData.register(this.render);

        } else {

            if (this._paginationSourceData) {
                this._paginationSourceData.unregister(this.render);
            }
        }
    }

    /**
     * Determines the group fields for the search query options inside the property pane
     */
    private _getSearchQueryFields(): IPropertyPaneConditionalGroup {

        let defaultSearchQueryFields: IPropertyPaneField<any>[] = [];

        if (!!this.properties.queryKeywords.tryGetSource()) {
            defaultSearchQueryFields.push(
                PropertyPaneCheckbox('useDefaultSearchQuery', {
                    text: strings.UseDefaultSearchQueryKeywordsFieldLabel
                })
            );
        }

        if (this.properties.useDefaultSearchQuery) {
            defaultSearchQueryFields.push(
                PropertyPaneTextField('defaultSearchQuery', {
                    label: strings.DefaultSearchQueryKeywordsFieldLabel,
                    description: strings.DefaultSearchQueryKeywordsFieldDescription,
                    multiline: true,
                    resizable: true,
                    placeholder: strings.SearchQueryPlaceHolderText,
                    onGetErrorMessage: this._validateEmptyField.bind(this),
                    deferredValidationTime: 500
                })
            );
        }

        return {
            primaryGroup: {
                groupFields: [
                    PropertyPaneTextField('queryKeywords', {
                        label: strings.SearchQueryKeywordsFieldLabel,
                        description: strings.SearchQueryKeywordsFieldDescription,
                        multiline: true,
                        resizable: true,
                        placeholder: strings.SearchQueryPlaceHolderText,
                        onGetErrorMessage: this._validateEmptyField.bind(this),
                        deferredValidationTime: 500
                    })
                ]
            },
            secondaryGroup: {
                groupFields: [
                    PropertyPaneDynamicFieldSet({
                        label: strings.SearchQueryKeywordsFieldLabel,

                        fields: [
                            PropertyPaneDynamicField('queryKeywords', {
                                label: strings.SearchQueryKeywordsFieldLabel
                            })
                        ],
                        sharedConfiguration: {
                            depth: DynamicDataSharedDepth.Source,
                        },
                    }),
                ].concat(defaultSearchQueryFields)
            },
            // Show the secondary group only if the web part has been
            // connected to a dynamic data source
            showSecondaryGroup: !!this.properties.queryKeywords.tryGetSource(),
            onShowPrimaryGroup: () => {

                // Reset dynamic data fields related values to be consistent
                this.properties.useDefaultSearchQuery = false;
                this.properties.defaultSearchQuery = '';
                this.properties.queryKeywords.setValue('');
                this.render();
            }
        } as IPropertyPaneConditionalGroup;
    }

    /**
     * Determines the group fields for styling options inside the property pane
     */
    private _getStylingFields(): IPropertyPaneField<any>[] {

        // Options for the search results layout 
        const layoutOptions = [
            {
                iconProps: {
                    officeFabricIconFontName: 'List'
                },
                text: strings.ListLayoutOption,
                key: ResultsLayoutOption.List,
            },
            {
                iconProps: {
                    officeFabricIconFontName: 'Tiles'
                },
                text: strings.TilesLayoutOption,
                key: ResultsLayoutOption.Tiles
            }
        ] as IPropertyPaneChoiceGroupOption[];

        layoutOptions.push(...this.getCodeRenderers());
        layoutOptions.push({
            iconProps: {
                officeFabricIconFontName: 'Code'
            },
            text: strings.CustomLayoutOption,
            key: ResultsLayoutOption.Custom,
        });

        const canEditTemplate = this.properties.externalTemplateUrl && this.properties.selectedLayout === ResultsLayoutOption.Custom ? false : true;

        let dialogTextFieldValue;
        if (!this.codeRendererIsSelected()) {
            switch (this.properties.selectedLayout) {
                case ResultsLayoutOption.List:
                    dialogTextFieldValue = BaseTemplateService.getDefaultResultTypeListItem();
                    break;

                case ResultsLayoutOption.Tiles:
                    dialogTextFieldValue = BaseTemplateService.getDefaultResultTypeTileItem();
                    break;

                default:
                    dialogTextFieldValue = BaseTemplateService.getDefaultResultTypeCustomItem();
                    break;
            }
        }

        // Sets up styling fields
        let stylingFields: IPropertyPaneField<any>[] = [
            PropertyPaneTextField('webPartTitle', {
                label: strings.WebPartTitle
            }),
            PropertyPaneToggle('showBlank', {
                label: strings.ShowBlankLabel,
                checked: this.properties.showBlank,
            }),
            PropertyPaneToggle('showResultsCount', {
                label: strings.ShowResultsCountLabel,
                checked: this.properties.showResultsCount,
            }),
            PropertyPaneToggle('showPaging', {
                label: strings.UsePaginationWebPartLabel,
                checked: this.properties.showPaging,
            }),
            PropertyPaneHorizontalRule(),
            PropertyPaneChoiceGroup('selectedLayout', {
                label: strings.ResultsLayoutLabel,
                options: layoutOptions
            }),
        ];

        if (this.properties.showPaging) {
            stylingFields.splice(4, 0,
                PropertyPaneDropdown('paginationDataSourceReference', {
                    options: this._dynamicDataService.getAvailableDataSourcesByType(SearchComponentType.PaginationWebPart),
                    label: strings.UsePaginationFromComponentLabel
                }));
        }

        if (!this.codeRendererIsSelected()) {
            stylingFields.push(
                this._propertyFieldCodeEditor('inlineTemplateText', {
                    label: strings.DialogButtonLabel,
                    panelTitle: strings.DialogTitle,
                    initialValue: this._templateContentToDisplay,
                    deferredValidationTime: 500,
                    onPropertyChange: this.onPropertyPaneFieldChanged,
                    properties: this.properties,
                    disabled: !canEditTemplate,
                    key: 'inlineTemplateTextCodeEditor',
                    language: this._propertyFieldCodeEditorLanguages.Handlebars
                }),
                PropertyFieldCollectionData('resultTypes', {
                    manageBtnLabel: strings.ResultTypes.EditResultTypesLabel,
                    key: 'resultTypes',
                    panelHeader: strings.ResultTypes.EditResultTypesLabel,
                    panelDescription: strings.ResultTypes.ResultTypesDescription,
                    enableSorting: true,
                    label: strings.ResultTypes.ResultTypeslabel,
                    value: this.properties.resultTypes,
                    fields: [
                        {
                            id: 'property',
                            title: strings.ResultTypes.ConditionPropertyLabel,
                            type: CustomCollectionFieldType.string,
                            required: true,
                        },
                        {
                            id: 'operator',
                            title: strings.ResultTypes.CondtionOperatorValue,
                            type: CustomCollectionFieldType.dropdown,
                            defaultValue: ResultTypeOperator.Equal,
                            required: true,
                            options: [
                                {
                                    key: ResultTypeOperator.Equal,
                                    text: strings.ResultTypes.EqualOperator
                                },
                                {
                                    key: ResultTypeOperator.Contains,
                                    text: strings.ResultTypes.ContainsOperator
                                },
                                {
                                    key: ResultTypeOperator.StartsWith,
                                    text: strings.ResultTypes.StartsWithOperator
                                },
                                {
                                    key: ResultTypeOperator.NotNull,
                                    text: strings.ResultTypes.NotNullOperator
                                },
                                {
                                    key: ResultTypeOperator.GreaterOrEqual,
                                    text: strings.ResultTypes.GreaterOrEqualOperator
                                },
                                {
                                    key: ResultTypeOperator.GreaterThan,
                                    text: strings.ResultTypes.GreaterThanOperator
                                },
                                {
                                    key: ResultTypeOperator.LessOrEqual,
                                    text: strings.ResultTypes.LessOrEqualOperator
                                },
                                {
                                    key: ResultTypeOperator.LessThan,
                                    text: strings.ResultTypes.LessThanOperator
                                }
                            ]
                        },
                        {
                            id: 'value',
                            title: strings.ResultTypes.ConditionValueLabel,
                            type: CustomCollectionFieldType.string,
                            required: false,
                        },
                        {
                            id: "inlineTemplateContent",
                            title: "Inline template",
                            type: CustomCollectionFieldType.custom,
                            onCustomRender: (field, value, onUpdate) => {
                                return (
                                    React.createElement("div", null,
                                        React.createElement(this._textDialogComponent.TextDialog, {
                                            language: this._propertyFieldCodeEditorLanguages.Handlebars,
                                            dialogTextFieldValue: value ? value : dialogTextFieldValue,
                                            onChanged: (fieldValue) => onUpdate(field.id, fieldValue),
                                            strings: {
                                                cancelButtonText: strings.CancelButtonText,
                                                dialogButtonText: strings.DialogButtonText,
                                                dialogTitle: strings.DialogTitle,
                                                saveButtonText: strings.SaveButtonText
                                            }
                                        })
                                    )
                                );
                            }
                        },
                        {
                            id: 'externalTemplateUrl',
                            title: strings.ResultTypes.ExternalUrlLabel,
                            type: CustomCollectionFieldType.url,
                            onGetErrorMessage: this._onTemplateUrlChange.bind(this),
                            placeholder: 'https://mysite/Documents/external.html'
                        },
                    ]
                })
            );
        }
        // Only show the template external URL for 'Custom' option
        if (this.properties.selectedLayout === ResultsLayoutOption.Custom) {
            stylingFields.splice(6, 0, PropertyPaneTextField('externalTemplateUrl', {
                label: strings.TemplateUrlFieldLabel,
                placeholder: strings.TemplateUrlPlaceholder,
                deferredValidationTime: 500,
                onGetErrorMessage: this._onTemplateUrlChange.bind(this)
            }));
        }
        if (this.codeRendererIsSelected()) {
            const currentCodeRenderer = find(this._codeRenderers, (renderer) => renderer.id === (this.properties.selectedLayout as any));
            if (!this.properties.customTemplateFieldValues) {
                this.properties.customTemplateFieldValues = currentCodeRenderer.customFields.map(field => {
                    return {
                        fieldName: field,
                        searchProperty: ''
                    };
                });
            }
            if (currentCodeRenderer && currentCodeRenderer.customFields && currentCodeRenderer.customFields.length > 0) {
                const searchPropertyOptions = this.properties.selectedProperties.split(',').map(prop => {
                    return ({
                        key: prop,
                        text: prop
                    });
                });
                stylingFields.push(PropertyFieldCollectionData('customTemplateFieldValues', {
                    key: 'customTemplateFieldValues',
                    label: strings.customTemplateFieldsLabel,
                    panelHeader: strings.customTemplateFieldsPanelHeader,
                    manageBtnLabel: strings.customTemplateFieldsConfigureButtonLabel,
                    value: this.properties.customTemplateFieldValues,
                    fields: [
                        {
                            id: 'fieldName',
                            title: strings.customTemplateFieldTitleLabel,
                            type: CustomCollectionFieldType.string,
                        },
                        {
                            id: 'searchProperty',
                            title: strings.customTemplateFieldPropertyLabel,
                            type: CustomCollectionFieldType.dropdown,
                            options: searchPropertyOptions
                        }
                    ]
                }));
            }
        }

        return stylingFields;
    }

    protected getCodeRenderers(): IPropertyPaneChoiceGroupOption[] {
        const registeredRenderers = this._codeRenderers;
        if (registeredRenderers && registeredRenderers.length > 0) {
            return registeredRenderers.map(ca => {
                return {
                    key: ca.id,
                    text: ca.name,
                    iconProps: {
                        officeFabricIconFontName: ca.icon
                    },
                };
            });
        } else {
            return [];
        }
    }

    protected codeRendererIsSelected(): boolean {
        const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
        return guidRegex.test(this.properties.selectedLayout as any);
    }

    public getPropertyDefinitions(): ReadonlyArray<IDynamicDataPropertyDefinition> {

        // Use the Web Part title as property title since we don't expose sub properties
        return [
            {
                id: SearchComponentType.SearchResultsWebPart,
                title: this.properties.webPartTitle ? this.properties.webPartTitle : this.title
            }
        ];
    }

    public getPropertyValue(propertyId: string): ISearchResultSourceData {

        const searchResultSourceData: ISearchResultSourceData = {
            queryKeywords: this._dynamicDataService.getDataSourceValue(this.properties.queryKeywords, this.properties.sourceId, this.properties.propertyId, this.properties.propertyPath),
            refinementResults: (this._resultService && this._resultService.results) ? this._resultService.results.RefinementResults : [],
            paginationInformation: (this._resultService && this._resultService.results) ? this._resultService.results.PaginationInformation : {
                CurrentPage: 1,
                MaxResultsPerPage: this.properties.maxResultsCount,
                TotalRows: 0
            },
            searchServiceConfiguration: this._searchService.getConfiguration(),
            verticalsInformation: this._verticalsInformation
        };

        switch (propertyId) {
            case SearchComponentType.SearchResultsWebPart:
                return searchResultSourceData;
        }

        throw new Error('Bad property id');
    }
}