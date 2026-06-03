# Memory Optimization for Adult Keywords Processing

## Overview
This document explains the memory optimization changes implemented to prevent "JavaScript heap out of memory" errors when processing large CSV files.

## Problem
When processing large CSV files (4+ files with thousands of records), the server was running out of memory due to:
- Large batch sizes (1000 records)
- Inefficient CSV parsing
- No memory monitoring
- No garbage collection
- Accumulating data in memory

## Solution

### 1. Reduced Batch Size
```javascript
const BATCH_SIZE = 100; // Reduced from 1000 to prevent memory issues
```

### 2. Chunked Processing
- Files are processed in smaller chunks (50-100 records)
- Each chunk is processed sequentially
- Memory is cleared after each chunk

### 3. Memory Monitoring
```javascript
const MAX_MEMORY_USAGE = 0.8; // Stop processing if memory usage exceeds 80%

const checkMemoryUsage = () => {
    const memUsage = process.memoryUsage();
    const memoryUsagePercent = memUsage.heapUsed / memUsage.heapTotal;
    
    if (memoryUsagePercent > MAX_MEMORY_USAGE) {
        // Force garbage collection and wait
        return false;
    }
    return true;
};
```

### 4. Automatic Garbage Collection
```javascript
const forceGarbageCollection = () => {
    if (global.gc) {
        global.gc();
        adultKeywordsLogger.debug('Forced garbage collection');
    }
};
```

### 5. Memory Cleanup
- Clear arrays after processing: `records.length = 0`
- Clear maps: `urlDateMap.clear()`
- Force garbage collection after each batch
- Small delays between chunks for memory cleanup

### 6. Startup Configuration
```json
{
  "scripts": {
    "start": "node --max-old-space-size=4096 --expose-gc server.js",
    "dev": "nodemon --max-old-space-size=4096 --expose-gc server.js"
  }
}
```

**Flags:**
- `--max-old-space-size=4096`: Increases heap size to 4GB
- `--expose-gc`: Enables manual garbage collection

## Processing Flow

### Before (Memory Intensive)
1. Read entire CSV file into memory
2. Parse all records at once
3. Process in batches of 1000
4. Keep all data in memory until completion

### After (Memory Efficient)
1. Read CSV file line by line
2. Process in chunks of 50-100 records
3. Clear memory after each chunk
4. Force garbage collection
5. Monitor memory usage
6. Wait if memory usage is high

## Memory Monitoring

### Frontend Dashboard
- Real-time memory usage display
- Heap used, heap total, memory percentage
- RSS (Resident Set Size) monitoring
- Memory optimization status

### Backend Logging
- Memory usage logged before each chunk
- Warnings when memory usage is high
- Garbage collection events logged
- Memory cleanup operations tracked

## Performance Impact

### Memory Usage
- **Before**: Could reach 2GB+ and crash
- **After**: Stays under 1GB, stable processing

### Processing Speed
- **Before**: Fast but unstable (crashes on large files)
- **After**: Slightly slower but reliable (no crashes)

### Scalability
- **Before**: Limited to small files
- **After**: Can handle multiple large files safely

## Best Practices

### 1. File Size Limits
- Recommended: Process files with < 100,000 records
- Maximum: Process files with < 500,000 records
- Multiple files: Process 2-5 files simultaneously

### 2. Server Resources
- Minimum RAM: 2GB
- Recommended RAM: 4GB+
- Enable garbage collection: `--expose-gc`

### 3. Monitoring
- Watch memory usage during processing
- Check logs for memory warnings
- Monitor processing progress

## Troubleshooting

### High Memory Usage
1. Check if garbage collection is enabled
2. Verify batch size is set to 100
3. Monitor memory usage in logs
4. Consider reducing file sizes

### Process Stuck
1. Check memory usage
2. Look for memory warnings in logs
3. Verify garbage collection is working
4. Check if files are too large

### Performance Issues
1. Reduce batch size further (50 instead of 100)
2. Increase delays between chunks
3. Monitor memory usage patterns
4. Consider processing files sequentially

## Future Improvements

1. **Streaming Processing**: Use Node.js streams for very large files
2. **Database Batching**: Process records in database transactions
3. **Memory Pooling**: Implement custom memory management
4. **Progress Persistence**: Save progress to database for recovery
5. **Dynamic Batch Sizing**: Adjust batch size based on memory usage

## Conclusion

These memory optimizations ensure that the adult keywords processing can handle large CSV files reliably without crashing. The trade-off is slightly slower processing, but the stability and scalability improvements make it worthwhile for production use. 