import RefinersSortOption from './RefinersSortOptions';
import RefinerTemplateOption from './RefinerTemplateOption';

interface IRefinerConfiguration {
    
    /**
     * The SharePoint refiner name
     */
    refinerName: string;


    /**
     * The refiner name to display in the UI
     */
    displayValue: string;

    /**
     * The selected template for this refiner
     */
    template: RefinerTemplateOption;

    /**
     * How the refiner values should be sorted
     */
    refinerSortType: RefinersSortOption;

    /** 
     * Allow refiners to be expanded by default
     */    
     showExpanded: boolean;
}

export default IRefinerConfiguration;