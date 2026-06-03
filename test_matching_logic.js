// test_matching_logic.js
const { adultKeywords_exact_match, adultKeywords_contains } = require('./utils/adult_keywords');

// Test the improved matching logic
function checkExactMatch(text) {
    if (!text) return null;
    const lowerText = text.toLowerCase();
    
    for (const keyword of adultKeywords_exact_match) {
        const lowerKeyword = keyword.toLowerCase();
        
        // Check for exact phrase match (word boundaries)
        if (lowerText.includes(lowerKeyword)) {
            // Additional check: ensure it's not part of a larger word
            const regex = new RegExp(`\\b${lowerKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (regex.test(text)) {
                return keyword;
            }
        }
    }
    return null;
}

function checkContainsMatch(text) {
    if (!text) return [];
    const lowerText = text.toLowerCase();
    const matches = [];
    
    for (const keyword of adultKeywords_contains) {
        const lowerKeyword = keyword.toLowerCase();
        
        if (lowerText.includes(lowerKeyword)) {
            const regex = new RegExp(`\\b${lowerKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (regex.test(text)) {
                matches.push(keyword);
            }
        }
    }
    return matches;
}

// Test cases
const testCases = [
    "Harker Garden Buildings | Garden Sheds Carlisle Cumbria - Harker Garden Buildings",
    "adult content found here",
    "This contains erotic material",
    "adultbabies website",
    "adult baby content",
    "adult content",
    "adultbabies",
    "adult baby",
    "adult content found",
    "adult content here",
    "adult content there",
    "adult content everywhere",
    "adult content in title",
    "adult content in description",
    "adult content in keywords"
];

console.log('🧪 Testing Improved Matching Logic\n');

testCases.forEach((testCase, index) => {
    console.log(`Test ${index + 1}: "${testCase}"`);
    
    const exactMatch = checkExactMatch(testCase);
    const containsMatch = checkContainsMatch(testCase);
    
    if (exactMatch) {
        console.log(`  ✅ EXACT MATCH: "${exactMatch}"`);
    } else {
        console.log(`  ❌ No exact match`);
    }
    
    if (containsMatch.length > 0) {
        console.log(`  🔍 CONTAINS MATCHES: ${containsMatch.join(', ')}`);
    } else {
        console.log(`  ❌ No contains matches`);
    }
    
    console.log('');
});

console.log('📊 Summary:');
console.log('- EXACT matches: Only when the exact phrase from adultKeywords_exact_match is found');
console.log('- CONTAINS matches: When any keyword from adultKeywords_contains is found');
console.log('- Both use word boundaries to avoid partial word matches');
console.log('- This prevents false positives like "adult" matching "adultbabies"'); 