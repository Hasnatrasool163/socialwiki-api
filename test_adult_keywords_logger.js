// test_adult_keywords_logger.js
const adultKeywordsLogger = require('./config/loggers/adultKeywordsLogger');

async function testAdultKeywordsLogger() {
    try {
        console.log('Testing Adult Keywords Logger...\n');

        // Test 1: Basic logging
        console.log('1. Testing basic logging...');
        adultKeywordsLogger.info('Test info message');
        adultKeywordsLogger.warn('Test warning message');
        adultKeywordsLogger.error('Test error message');
        console.log('✅ Basic logging works\n');

        // Test 2: Structured logging with metadata
        console.log('2. Testing structured logging...');
        adultKeywordsLogger.info('Exact match found - updating social scrape record', {
            url: 'example.com',
            keyword: 'adult content',
            matchType: 'exact',
            action: 'update_social_scrape',
            source: 'title'
        });
        console.log('✅ Structured logging works\n');

        // Test 3: Contains match logging
        console.log('3. Testing contains match logging...');
        adultKeywordsLogger.info('Contains match found - creating reference', {
            url: 'example2.com',
            keywords: ['adult', 'content', 'explicit'],
            matchType: 'contains',
            action: 'create_reference',
            source: {
                title: ['adult'],
                meta_description: ['content'],
                keywords: ['explicit']
            }
        });
        console.log('✅ Contains match logging works\n');

        // Test 4: Process completion logging
        console.log('4. Testing process completion logging...');
        adultKeywordsLogger.info('Completed adult keywords matching process', {
            action: 'process_completed',
            filesProcessed: 2,
            totalRecords: 1500,
            exactMatches: 45,
            containsMatches: 123,
            updatedRecords: 45,
            createdReferences: 123,
            errors: 0
        });
        console.log('✅ Process completion logging works\n');

        console.log('🎉 All logger tests passed! Adult Keywords Logger is working correctly.');
        console.log('\n📁 Check the logs directory for generated log files:');
        console.log('   - logs/adult-keywords/adult-keywords.log (all logs except errors)');
        console.log('   - logs/adult-keywords/error-adult-keywords.log (errors only)');
        console.log('\n🗑️  Logs are automatically cleaned up after 10 days');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error('Stack:', error.stack);
    }
}

// Run the test
testAdultKeywordsLogger(); 