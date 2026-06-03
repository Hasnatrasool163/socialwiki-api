# Adult Keywords Logging System

This document describes the comprehensive logging system for the adult keywords matching process.

## Overview

The adult keywords logging system provides detailed, structured logging for all aspects of the adult content detection process. It creates separate log files for different types of events and includes comprehensive metadata for each log entry.

## Logger Configuration

### Location
- **Config File**: `server/config/loggers/adultKeywordsLogger.js`
- **Logs Directory**: `server/logs/`

### Environment Variables
```bash
ADULT_KEYWORDS_LOG_LEVEL=info  # Default: info
```

## Log Files Generated

### 1. `adult-keywords.log` - All Logs (Except Errors)
Contains all log entries from the adult keywords process (info, warn, debug levels).

### 2. `error-adult-keywords.log` - Errors Only
Contains only error-level logs for troubleshooting.

## Log Format

Each log entry follows this structured format:
```
[YYYY-MM-DD HH:mm:ss] [LEVEL] Message | URL: example.com | Keyword: adult content | Match Type: exact | Action: update_social_scrape | Meta: {...}
```

## Log Levels and Events

### INFO Level Events

#### Process Management
- **Process Started**: When adult keywords matching begins
- **Process Completed**: When all files have been processed
- **File Processing**: Start/completion of individual file processing
- **Batch Processing**: Progress updates for batch processing

#### Exact Matches
- **Exact Match Found**: When an exact keyword match is detected
- **Record Updated**: When a social scrape record is successfully updated
- **File Moved**: When a processed file is moved to completed directory

#### Contains Matches
- **Contains Match Found**: When partial keyword matches are detected
- **Reference Created**: When a new reference is created
- **Reference Updated**: When an existing reference is updated

#### Skipped Records
- **Record Skipped**: When a record is skipped (not in social scrape database)

### WARN Level Events
- **No Record Found**: When attempting to update non-existent records
- **No Social Scrape Record**: When attempting to create references for non-existent URLs

### ERROR Level Events
- **Processing Errors**: Errors during file processing, database operations, etc.
- **System Errors**: File system errors, database connection issues, etc.

## Example Log Entries

### Exact Match Detection
```
[2024-01-11 20:15:30] [INFO] Exact match found - updating social scrape record | URL: example.com | Keyword: adult content | Match Type: exact | Action: update_social_scrape | Source: title
```

### Contains Match Detection
```
[2024-01-11 20:15:31] [INFO] Contains match found - creating reference | URL: example2.com | Keywords: adult,content,explicit | Match Type: contains | Action: create_reference | Source: {"title":["adult"],"meta_description":["content"],"keywords":["explicit"]}
```

### Process Completion
```
[2024-01-11 20:20:45] [INFO] Completed adult keywords matching process | Action: process_completed | Files Processed: 2 | Total Records: 1500 | Exact Matches: 45 | Contains Matches: 123 | Updated Records: 45 | Created References: 123 | Errors: 0
```

### Record Skipped
```
[2024-01-11 20:15:32] [INFO] Skipping record - not found in social scrape database | URL: example3.com | Match Type: none | Action: skip_processing | Reason: no_social_scrape_record
```

## Testing the Logger

Run the test script to verify the logger is working:
```bash
cd server
node test_adult_keywords_logger.js
```

This will generate sample log entries in both log files.

## Monitoring and Analysis

### Real-time Monitoring
```bash
# Watch all logs
tail -f logs/adult-keywords/adult-keywords.log

# Watch only errors
tail -f logs/adult-keywords/error-adult-keywords.log
```

### Log Analysis
```bash
# Count exact matches
grep "Exact match found" logs/adult-keywords/adult-keywords.log | wc -l

# Count contains matches
grep "Contains match found" logs/adult-keywords/adult-keywords.log | wc -l

# Find URLs with specific keywords
grep "adult content" logs/adult-keywords/adult-keywords.log

# Find errors for specific URLs
grep "example.com" logs/adult-keywords/error-adult-keywords.log
```

## Log Management

### Auto-Cleanup
- **Retention Period**: Logs are automatically deleted after 10 days
- **Cleanup Frequency**: Runs every 24 hours
- **File Rotation**: Logs rotate when they reach 50MB
- **Max Files**: Keeps up to 10 rotated files per log type

### File Sizes
- **Main Log**: 50MB max size before rotation
- **Error Log**: 50MB max size before rotation
- **Total Storage**: Maximum 1GB (10 files × 50MB × 2 types)

## Integration

The logger is automatically used by the `AdultKeywords.service.js` and provides comprehensive coverage of:
- File processing progress
- Keyword matching results
- Database operations
- Error handling
- Process statistics

All logs include structured metadata for easy parsing and analysis. 