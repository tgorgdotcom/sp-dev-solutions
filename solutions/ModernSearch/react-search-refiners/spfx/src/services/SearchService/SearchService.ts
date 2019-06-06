import * as Handlebars from 'handlebars';
import ISearchService from './ISearchService';
import { ISearchResults, ISearchResult, IRefinementResult, IRefinementValue, IRefinementFilter, IPromotedResult, ISearchVerticalInformation } from '../../models/ISearchResult';
import { sp, SearchQuery, SearchResults, SPRest, Sort, SearchSuggestQuery } from '@pnp/sp';
import { Logger, LogLevel, ConsoleListener } from '@pnp/logging';
import { Text, Guid } from '@microsoft/sp-core-library';
import { sortBy, isEmpty, escape } from '@microsoft/sp-lodash-subset';
import LocalizationHelper from '../../helpers/LocalizationHelper';
import "@pnp/polyfill-ie11";
import IRefinerConfiguration from '../../models/IRefinerConfiguration';
import { ISearchServiceConfiguration } from '../../models/ISearchServiceConfiguration';
import { ITokenService, TokenService } from '../TokenService';
import { PageContext } from '@microsoft/sp-page-context';
import { SPHttpClient } from '@microsoft/sp-http';
import ISynonymTable from '../../models/ISynonym';
import { JSONParser } from '@pnp/odata';
import { UrlHelper } from '../../helpers/UrlHelper';
import { ISearchVertical } from '../../models/ISearchVertical';

class SearchService implements ISearchService {
    private _initialSearchResult: SearchResults = null;
    private _resultsCount: number;
    private _pageContext: PageContext;
    private _tokenService: ITokenService;
    private _selectedProperties: string[];
    private _queryTemplate: string;
    private _resultSourceId: string;
    private _sortList: Sort[];
    private _enableQueryRules: boolean;
    private _refiners: IRefinerConfiguration[];
    private _refinementFilters: IRefinementFilter[];
    private _synonymTable: ISynonymTable;

    public get resultsCount(): number { return this._resultsCount; }
    public set resultsCount(value: number) { this._resultsCount = value; }

    public set selectedProperties(value: string[]) { this._selectedProperties = value; }
    public get selectedProperties(): string[] { return this._selectedProperties; }

    public set queryTemplate(value: string) { this._queryTemplate = value; }
    public get queryTemplate(): string { return this._queryTemplate; }

    public set resultSourceId(value: string) { this._resultSourceId = value; }
    public get resultSourceId(): string { return this._resultSourceId; }

    public set sortList(value: Sort[]) { this._sortList = value; }
    public get sortList(): Sort[] { return this._sortList; }

    public set enableQueryRules(value: boolean) { this._enableQueryRules = value; }
    public get enableQueryRules(): boolean { return this._enableQueryRules; }

    public set refiners(value: IRefinerConfiguration[]) { this._refiners = value; }
    public get refiners(): IRefinerConfiguration[] { return this._refiners; }

    public set refinementFilters(value: IRefinementFilter[]) { this._refinementFilters = value; }
    public get refinementFilters(): IRefinementFilter[] { return this._refinementFilters; }

    public set synonymTable(value: ISynonymTable) { this._synonymTable = value; }
    public get synonymTable(): ISynonymTable { return this._synonymTable; }

    private _localPnPSetup: SPRest;

    public constructor(pageContext: PageContext, spHttpClient: SPHttpClient) {
        this._pageContext = pageContext;
        this._tokenService = new TokenService(this._pageContext, spHttpClient);

        // Setup the PnP JS instance
        const consoleListener = new ConsoleListener();
        Logger.subscribe(consoleListener);

        // To limit the payload size, we set odata=nometadata
        // We just need to get list items here
        // We use a local configuration to avoid conflicts with other Web Parts
        this._localPnPSetup = sp.configure({
            headers: {
                Accept: 'application/json; odata=nometadata',
            },
        }, this._pageContext.web.absoluteUrl);
    }

    /**
     * Performs a search query against SharePoint
     * @param query The search query in KQL format
     * @return The search results
     */
    public async search(query: string, pageNumber?: number): Promise<ISearchResults> {

        let searchQuery: SearchQuery = {};
        let sortedRefiners: string[] = [];

        // Search paging option is one based
        let page = pageNumber ? pageNumber : 1;

        searchQuery.ClientType = 'ContentSearchRegular';
        searchQuery.Properties = [{
            Name: "EnableDynamicGroups",
            Value: {
                BoolVal: true,
                QueryPropertyValueTypeIndex: 3
            }
        }, {
            Name: "EnableMultiGeoSearch",
            Value: {
                BoolVal: true,
                QueryPropertyValueTypeIndex: 3
            }
        }];
        searchQuery.Querytext = this._injectSynonyms(query);

        // Disable query rules by default if not specified
        searchQuery.EnableQueryRules = this._enableQueryRules ? this._enableQueryRules : false;

        if (this._resultSourceId) {
            searchQuery.SourceId = this._resultSourceId;
        }

        // To be able to use search query variable according to the current context
        // http://www.techmikael.com/2015/07/sharepoint-rest-do-support-query.html
        searchQuery.QueryTemplate = await this._tokenService.replaceQueryVariables(this._queryTemplate);

        searchQuery.RowLimit = this._resultsCount ? this._resultsCount : 50;
        searchQuery.SelectProperties = this._selectedProperties;
        searchQuery.TrimDuplicates = false;
        searchQuery.SortList = this._sortList ? this._sortList : [];

        if (this.refiners) {
            // Get the refiners order specified in the property pane
            sortedRefiners = this.refiners.map(e => e.refinerName);
            searchQuery.Refiners = sortedRefiners.join(',');
        }

        if (this.refinementFilters) {
            if (this.refinementFilters.length > 0) {
                searchQuery.RefinementFilters = this._buildRefinementQueryString(this.refinementFilters);
            }
        }

        let results: ISearchResults = {
            QueryKeywords: query,
            RelevantResults: [],
            RefinementResults: [],
            PaginationInformation: {
                CurrentPage: pageNumber,
                MaxResultsPerPage: this.resultsCount,
                TotalRows: 0
            }
        };

        try {
            if (!this._initialSearchResult || page == 1) {
                this._initialSearchResult = await this._localPnPSetup.search(searchQuery);
            }

            let refinementResults: IRefinementResult[] = [];

            // Need to do this check
            // More info here: https://github.com/SharePoint/PnP-JS-Core/issues/337
            if (this._initialSearchResult.RawSearchResults.PrimaryQueryResult) {

                // Be careful, there was an issue with paging calculation under 2.0.8 version of sp-pnp-js library
                // More info https://github.com/SharePoint/PnP-JS-Core/issues/535
                let r2 = this._initialSearchResult;
                if (page > 1) {
                    r2 = await this._initialSearchResult.getPage(page, this._resultsCount);
                }

                const resultRows = r2.RawSearchResults.PrimaryQueryResult.RelevantResults.Table.Rows;
                let refinementResultsRows = r2.RawSearchResults.PrimaryQueryResult.RefinementResults;

                const refinementRows: any = refinementResultsRows ? refinementResultsRows.Refiners : [];
                if (refinementRows.length > 0 && (<any>window).searchHBHelper === undefined) {
                    const component = await import(
                        /* webpackChunkName: 'search-handlebars-helpers' */
                        'handlebars-helpers'
                    );
                    if ((<any>window).searchHBHelper === undefined) {
                        (<any>window).searchHBHelper = component({
                            handlebars: Handlebars
                        });
                    }
                }

                // Map search results
                let searchResults: ISearchResult[] = resultRows.map((elt) => {

                    // Build item result dynamically
                    // We can't type the response here because search results are by definition too heterogeneous so we treat them as key-value object
                    let result: ISearchResult = {};

                    elt.Cells.map((item) => {
                        result[item.Key] = item.Value;
                    });

                    return result;
                });

                // Map results icon (using batch)
                searchResults = await this._mapToIcons(searchResults);

                // Map refinement results                    
                refinementRows.map((refiner) => {

                    let values: IRefinementValue[] = [];
                    refiner.Entries.map((item) => {
                        values.push({
                            RefinementCount: parseInt(item.RefinementCount, 10),
                            RefinementName: this._formatDate(item.RefinementName), // This value will appear in the selected filter bar
                            RefinementToken: item.RefinementToken,
                            RefinementValue: this._formatDate(item.RefinementValue), // This value will appear in the filter panel
                        });
                    });

                    refinementResults.push({
                        FilterName: refiner.Name,
                        Values: values,
                    });
                });

                // Query rules handling
                const secondaryQueryResults = r2.RawSearchResults.SecondaryQueryResults;
                if (Array.isArray(secondaryQueryResults) && secondaryQueryResults.length > 0) {

                    let promotedResults: IPromotedResult[] = [];

                    secondaryQueryResults.map((e) => {

                        // Best bets are mapped through the "SpecialTermResults" https://msdn.microsoft.com/en-us/library/dd907265(v=office.12).aspx
                        if (e.SpecialTermResults) {

                            e.SpecialTermResults.Results.map((result) => {
                                promotedResults.push({
                                    Title: result.Title,
                                    Url: result.Url,
                                    Description: result.Description
                                } as IPromotedResult);
                            });
                        }
                    });

                    results.PromotedResults = promotedResults;
                }

                // Sort refiners according to the property pane value
                refinementResults = sortBy(refinementResults, (refinement) => {

                    // Get the index of the corresponding filter name
                    return sortedRefiners.indexOf(refinement.FilterName);
                });

                results.RelevantResults = searchResults;
                results.RefinementResults = refinementResults;
                results.PaginationInformation.TotalRows = this._initialSearchResult.TotalRows;
            }
            return results;

        } catch (error) {
            Logger.write('[SharePointDataProvider.search()]: Error: ' + error, LogLevel.Error);
            throw error;
        }
    }

    /**
     * Retrieves search query suggestions
     * @param query the term to suggest from
     */
    public async suggest(query: string): Promise<string[]> {

        let suggestions: string[] = [];

        const searchSuggestQuery: SearchSuggestQuery = {
            preQuery: true,
            querytext: encodeURIComponent(query.replace(/'/g, '\'\'')),
            count: 10,
            hitHighlighting: true,
            prefixMatch: true,
            culture: LocalizationHelper.getLocaleId(this._pageContext.cultureInfo.currentUICultureName).toString()
        };

        try {
            const response = await this._localPnPSetup.searchSuggest(searchSuggestQuery);

            if (response.Queries.length > 0) {

                // Get only the suggesiton string value
                suggestions = response.Queries.map(elt => {
                    return elt.Query;
                });
            }

            return suggestions;

        } catch (error) {
            Logger.write("[SharePointDataProvider.suggest()]: Error: " + error, LogLevel.Error);
            throw error;
        }
    }

    /**
     * Retreives the result counts for each search vertical
     * @param queryText the search query text
     * @param searchVerticalsConfiguration the search verticals configuration
     * @param enableQueryRules enable query rules or not
     */
    public async getSearchVerticalCounts(queryText: string, searchVerticals: ISearchVertical[], enableQueryRules: boolean): Promise<ISearchVerticalInformation[]> {

        const batch = this._localPnPSetup.createBatch();   
        const parser = new JSONParser();     
        const batchId = Guid.newGuid().toString();
        let verticalInfos: ISearchVerticalInformation[] = [];
 
        const promises = searchVerticals.map(async vertical => {

            // Specify the same query parameters as the current vertical one to be sure to get the same total rows
            // POST request does not seem to work well with batching so we use a GET request here
            let url = `${this._pageContext.web.absoluteUrl}/_api/search/query`;

            // When query rules are enabled, we need to set the row limit to minimum 1 to get data in the 'PrimaryQueryResult' property and get the 'TotalRows'
            // More info here https://blog.mastykarz.nl/inconvenient-content-targeting-user-segments-search-rest-api/
            const rowLimit: string = enableQueryRules ? '1' : '0';

            url = UrlHelper.addOrReplaceQueryStringParam(url, 'querytext', `'${queryText.replace(/'/g, "''")}'`);
            url = UrlHelper.addOrReplaceQueryStringParam(url, 'rowlimit', rowLimit);
            url = UrlHelper.addOrReplaceQueryStringParam(url, 'querytemplate', `'${vertical.queryTemplate}'`);
            url = UrlHelper.addOrReplaceQueryStringParam(url, 'trimduplicates', "'false'");
            url = UrlHelper.addOrReplaceQueryStringParam(url, 'properties', "'EnableDynamicGroups:true,EnableMultiGeoSearch:true'");
            url = UrlHelper.addOrReplaceQueryStringParam(url, 'clienttype', "'ContentSearchRegular'");
            url = UrlHelper.addOrReplaceQueryStringParam(url, 'enablequeryrules', `${enableQueryRules}`);

            if (vertical.resultSourceId) {
                url = UrlHelper.addOrReplaceQueryStringParam(url, 'sourceid', `'${vertical.resultSourceId}'`);
            }

            return batch.add(url, 'GET', {
                headers: {
                    Accept: 'application/json; odata=nometadata'
                }
            }, parser, batchId);
        });
        
        // Execute the batch
        await batch.execute();

        const response = await Promise.all(promises);

        // Parse results and return counts for each vertical
        // We suppose the batch order follow the input verticals order
        response.map((result: any, index: number) => {

            let currentCount = null;
            if (result.PrimaryQueryResult) {
                currentCount = result.PrimaryQueryResult.RelevantResults.TotalRows;
            }

            // GET requests allow empty query text so we need to ensure there is actually a query to get the right count
            if (currentCount !== null && !isEmpty(queryText)) {
                verticalInfos.push(
                    {
                        Count: currentCount,
                        VerticalKey: searchVerticals[index].key
                    } as ISearchVerticalInformation
                );
            }
        });
        
        return verticalInfos;
    }

    /**
     * Gets the current search service properties configuration
     */
    public getConfiguration(): ISearchServiceConfiguration {
        return {
            enableQueryRules: this.enableQueryRules,
            queryTemplate: this.queryTemplate,
            refinementFilters: this.refinementFilters,
            refiners: this.refiners,
            resultSourceId: this.resultSourceId,
            resultsCount: this.resultsCount,
            selectedProperties: this.selectedProperties,
            sortList: this.sortList,
            synonymTable: this.synonymTable
        };
    }

    /**
     * Gets the icons corresponding to the result file name extensions
     * @param searchResults The raw search results
     */
    private async _mapToIcons(searchResults: ISearchResult[]): Promise<ISearchResult[]> {

        try {

            let updatedSearchResults = searchResults;

            const batch = this._localPnPSetup.createBatch();   
            const parser = new JSONParser();     
            const batchId = Guid.newGuid().toString();

            const promises = searchResults.map(async result => {
                
                const filename = result.Filename ? result.Filename : `.${result.FileExtension}`;

                let encodedFileName = filename ? filename.replace(/['']/g, '') : '';
                const queryStringIndex = encodedFileName.indexOf('?');
                if (queryStringIndex !== -1) { // filename with query string leads to 400 error.
                    encodedFileName = encodedFileName.slice(0, queryStringIndex);
                }

                let url = `${this._pageContext.web.absoluteUrl}/_api/web/maptoicon(filename='${encodeURIComponent(encodedFileName)}', progid='', size=1)`;

                return batch.add(url, 'GET', {
                    headers: {
                        Accept: 'application/json; odata=nometadata'
                    }
                }, parser, batchId);
            });

            // Execute the batch
            await batch.execute();

            const response = await Promise.all(promises);

            response.map((result: any, index: number) => {

                if (result.value) {
                    const iconUrl = this._pageContext.web.absoluteUrl + '/_layouts/15/images/' + result.value;
                    updatedSearchResults[index].IconSrc = iconUrl;
                }
            });

            return updatedSearchResults;

        } catch (error) {
            Logger.write('[SearchService._mapToIcons()]: Error: ' + error, LogLevel.Error);
            throw new Error(error);
        }
    }

    /**
     * Find and eeplace ISO 8601 dates in the string by a friendly value
     * @param inputValue The string to format
     */
    private _formatDate(inputValue: string): string {

        const iso8061rgx = /(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))/g;
        const matches = inputValue.match(iso8061rgx);

        let updatedInputValue = inputValue;

        if (matches) {
            matches.map(match => {
                updatedInputValue = updatedInputValue.replace(match, (<any>window).searchHBHelper.moment(match, "LL", { lang: this._pageContext.cultureInfo.currentUICultureName }));
            });
        }

        return updatedInputValue;
    }

    /**
     * Build the refinement condition in FQL format
     * @param selectedFilters The selected filter array
     * @param encodeTokens If true, encodes the taxonomy refinement tokens in UTF-8 to work with GET requests. Javascript encodes natively in UTF-16 by default.
     */
    private _buildRefinementQueryString(selectedFilters: IRefinementFilter[], encodeTokens?: boolean): string[] {

        let refinementQueryConditions: string[] = [];

        selectedFilters.map(filter => {
            if (filter.Values.length > 1) {

                // A refiner can have multiple values selected in a multi or mon multi selection scenario
                // The correct operator is determined by the refiner display template according to its behavior
                const conditions = filter.Values.map(value => {

                    return /ǂǂ/.test(value.RefinementToken) && encodeTokens ? encodeURIComponent(value.RefinementToken) : value.RefinementToken; 
                });
                refinementQueryConditions.push(`${filter.FilterName}:${filter.Operator}(${conditions.join(',')})`);
            } else {
                if (filter.Values.length === 1) {

                    // See https://sharepoint.stackexchange.com/questions/258081/how-to-hex-encode-refiners/258161
                    let refinementToken = /ǂǂ/.test(filter.Values[0].RefinementToken) && encodeTokens ? encodeURIComponent(filter.Values[0].RefinementToken) : filter.Values[0].RefinementToken;
                    refinementQueryConditions.push(`${filter.FilterName}:${refinementToken}`);
                }
            }
        });

        return refinementQueryConditions;
    }

    // Function to inject synonyms at run-time
    private _injectSynonyms(query: string): string {

        if (this._synonymTable && Object.keys(this._synonymTable).length > 0) {
            // Remove complex query parts AND/OR/NOT/ANY/ALL/parenthasis/property queries/exclusions - can probably be improved            
            const cleanQuery = query.replace(/(-\w+)|(-"\w+.*?")|(-?\w+[:=<>]+\w+)|(-?\w+[:=<>]+".*?")|((\w+)?\(.*?\))|(AND)|(OR)|(NOT)/g, '');
            const queryParts: string[] = cleanQuery.match(/("[^"]+"|[^"\s]+)/g);

            // code which should modify the current query based on context for each new query
            if (queryParts) {

                for (let i = 0; i < queryParts.length; i++) {
                    const key = queryParts[i].toLowerCase();
                    const value = this._synonymTable[key];

                    if (value) {
                        // Replace the current query part in the query with all the synonyms
                        query = query.replace(queryParts[i],
                            Text.format('({0} OR {1})',
                                this._formatSynonym(queryParts[i]),
                                this._formatSynonymsSearchQuery(value)));
                    }
                }
            }
        }
        return query;
    }

    private _formatSynonym(value: string): string {
        value = value.trim().replace(/"/g, '').trim();
        value = '"' + value + '"';

        return value;
    }

    private _formatSynonymsSearchQuery(items: string[]): string {
        let result = '';

        for (let i = 0; i < items.length; i++) {
            let item = items[i];

            if (item.length > 0) {
                item = this._formatSynonym(item);

                result += item;

                if (i < items.length - 1) {
                    result += ' OR ';
                }
            }
        }

        return result;
    }
}

export default SearchService;