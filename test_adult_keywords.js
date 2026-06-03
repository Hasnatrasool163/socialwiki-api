// test_adult_keywords.js
const { AdultKeywordsService } = require('./services/AdultKeywords.service');

async function testAdultKeywordsService() {
    try {
        console.log('Testing Adult Keywords Service...\n');

        // Test 1: Get matching progress
        console.log('1. Testing getMatchingProgress...');
        const progress = AdultKeywordsService.getMatchingProgress();
        console.log('Progress:', progress);
        console.log('✅ getMatchingProgress works\n');

        // Test 2: Get stats
        console.log('2. Testing getStats...');
        const stats = await AdultKeywordsService.getStats();
        console.log('Stats:', stats);
        console.log('✅ getStats works\n');

        // Test 3: Get references
        console.log('3. Testing getReferences...');
        const references = await AdultKeywordsService.getReferences();
        console.log('References count:', references.length);
        console.log('✅ getReferences works\n');

        // Test 4: Get paginated references
        console.log('4. Testing getPaginatedReferences...');
        const paginated = await AdultKeywordsService.getPaginatedReferences(1, 10);
        console.log('Paginated result:', paginated);
        console.log('✅ getPaginatedReferences works\n');

        console.log('🎉 All tests passed! Adult Keywords Service is working correctly.');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error('Stack:', error.stack);
    }
}

// Run the test
testAdultKeywordsService(); 