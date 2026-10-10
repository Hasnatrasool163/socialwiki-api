/**
 * index.js (Parent Search Controller)
 * Clean, lightweight aggregator that re-exports all modular search controllers.
 * Keeps backward compatibility with routes/searchRoutes.js.
 */

const { suggestRmAddress, cascadeRmAddress, searchRmAddress } = require('./rmSearchController');
const { searchPropPrice } = require('./propPriceSearchController');
const { searchCompany } = require('./companySearchController');
const { searchScreenshot } = require('./screenshotSearchController');
const { searchSocialScrape } = require('./socialSearchController');
const { searchBusiness } = require('./businessSearchController');
const { searchWebsites } = require('./websiteSearchController');
const { getUsage } = require('./usageController');

module.exports = {
    suggestRmAddress,
    cascadeRmAddress,
    searchRmAddress,
    searchPropPrice,
    searchCompany,
    searchScreenshot,
    searchSocialScrape,
    searchBusiness,
    searchWebsites,
    getUsage,
};
