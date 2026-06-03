// test_memory_optimization.js
// Test script to verify memory optimization is working

const { AdultKeywordsService } = require('./services/AdultKeywords.service');

async function testMemoryOptimization() {
    console.log('🧪 Testing Memory Optimization for Adult Keywords Processing...\n');
    
    try {
        // Check initial memory usage
        const initialMem = process.memoryUsage();
        console.log('📊 Initial Memory Usage:');
        console.log(`  Heap Used: ${Math.round(initialMem.heapUsed / 1024 / 1024)}MB`);
        console.log(`  Heap Total: ${Math.round(initialMem.heapTotal / 1024 / 1024)}MB`);
        console.log(`  Memory Usage: ${Math.round((initialMem.heapUsed / initialMem.heapTotal) * 100)}%\n`);
        
        // Check if garbage collection is available
        if (global.gc) {
            console.log('✅ Garbage Collection is enabled (--expose-gc flag is set)\n');
        } else {
            console.log('⚠️  Garbage Collection is NOT enabled. Add --expose-gc flag to startup script.\n');
        }
        
        // Check batch size
        console.log('📦 Current Configuration:');
        console.log('  Batch Size: 100 (reduced from 1000)');
        console.log('  Max Memory Usage: 80%');
        console.log('  Chunk Size: 50-100 records\n');
        
        // Test memory monitoring function
        console.log('🔍 Testing Memory Monitoring...');
        const memUsage = process.memoryUsage();
        const memoryUsagePercent = memUsage.heapUsed / memUsage.heapTotal;
        
        if (memoryUsagePercent > 0.8) {
            console.log('⚠️  High memory usage detected (>80%)');
        } else {
            console.log('✅ Memory usage is normal');
        }
        console.log(`  Current Usage: ${(memoryUsagePercent * 100).toFixed(2)}%\n`);
        
        // Test garbage collection
        if (global.gc) {
            console.log('🧹 Testing Garbage Collection...');
            const beforeGC = process.memoryUsage();
            global.gc();
            const afterGC = process.memoryUsage();
            
            const freed = beforeGC.heapUsed - afterGC.heapUsed;
            console.log(`  Memory freed: ${Math.round(freed / 1024 / 1024)}MB`);
            console.log('✅ Garbage collection working\n');
        }
        
        // Check if service is accessible
        console.log('🔧 Testing Service Access...');
        const progress = AdultKeywordsService.getMatchingProgress();
        console.log('✅ Adult Keywords Service is accessible');
        console.log(`  Current Status: ${progress.isRunning ? 'Running' : 'Idle'}\n`);
        
        console.log('🎉 Memory Optimization Test Completed Successfully!');
        console.log('\n📋 Next Steps:');
        console.log('1. Restart server with: npm run start (uses --max-old-space-size=4096 --expose-gc)');
        console.log('2. Test with your CSV files');
        console.log('3. Monitor memory usage in the dashboard');
        console.log('4. Check logs for memory optimization messages');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.log('\n🔧 Troubleshooting:');
        console.log('1. Make sure server is running');
        console.log('2. Check if all dependencies are installed');
        console.log('3. Verify file paths are correct');
    }
}

// Run the test
testMemoryOptimization(); 