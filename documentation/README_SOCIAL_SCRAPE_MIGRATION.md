# Social Scrape Import System Migration

## Overview

The social scrape import system has been updated to handle multiple records with the same URL but different dates. This change allows for more accurate data tracking over time.

## Changes Made

### 1. Database Schema Changes

**Before:**
- `url` field had a unique constraint
- Only one record allowed per URL

**After:**
- `url` field no longer has unique constraint
- Compound unique index on `{ url: 1, date: 1 }`
- Multiple records allowed for the same URL with different dates

### 2. Import Logic Changes

The import system now follows these rules:

1. **If URL and date are the same**: Overwrite the existing record with new data
2. **If URL is new**: Create a new record
3. **If URL exists but date is different**: Create a new record with the new date

### 3. Updated Functions

- `insertBatch()`: Now groups records by URL + date combination
- `mergeRecordsForSameUrlDate()`: New helper function to merge multiple records for the same URL + date
- `processBlacklistFile()`: Updated to handle multiple records with the same URL
- `ensureIndexes()`: Updated to create the new compound unique index

### 4. Logging System

**New Separate Logger:**
- Created dedicated logger for social scrape operations
- Logs are written to `logs/social_scrape-YYYY-MM-DD.log`
- Error logs are written to `logs/social_scrape-error-YYYY-MM-DD.log`
- Console output is prefixed with `[SOCIAL_SCRAPE]` for easy identification
- Logs are kept for 30 days with automatic rotation

## Migration Process

### Step 1: Run the Migration Script

Before using the updated import system, you must run the migration script to update your existing database:

```bash
cd server
node scripts/migrate_social_scrape_schema.js
```

This script will:
1. Find all existing duplicate URLs in your database
2. Update duplicate records with slightly different dates to make them unique
3. Drop the old unique index on URL
4. Create the new compound unique index on URL + date
5. Create additional indexes for performance

**Note:** The migration script will log all operations to the new social scrape log files.

### Step 2: Verify Migration

After running the migration, you can verify it worked by checking:

```javascript
// Check if the new index exists
db.socialscrapes.getIndexes()

// Should show an index like:
// { "url" : 1, "date" : 1 } with unique: true
```

### Step 3: Test the New Import System

1. Place your CSV files in the import directory
2. Start the import process
3. Verify that records are being created correctly according to the new rules
4. Check the logs in `logs/social_scrape-YYYY-MM-DD.log` for detailed import information

## How It Works

### Example Scenarios

**Scenario 1: Same URL, Same Date**
```
Input: URL=example.com, Date=2024-01-01, Title=New Title
Existing: URL=example.com, Date=2024-01-01, Title=Old Title
Result: Updates existing record with new title
```

**Scenario 2: New URL**
```
Input: URL=newsite.com, Date=2024-01-01, Title=New Site
Existing: No record for newsite.com
Result: Creates new record
```

**Scenario 3: Same URL, Different Date**
```
Input: URL=example.com, Date=2024-01-02, Title=Updated Title
Existing: URL=example.com, Date=2024-01-01, Title=Old Title
Result: Creates new record with Date=2024-01-02
```

### Record Merging

When multiple records in the same import file have the same URL + date combination, they are merged:

- **Text fields**: First non-empty value is used
- **Phone arrays**: All unique phone numbers are combined
- **Other fields**: First non-empty value is used

## Logging

### Log Files

The social scrape import system uses a dedicated logging system:

- **Main logs**: `logs/social_scrape-YYYY-MM-DD.log`
- **Error logs**: `logs/social_scrape-error-YYYY-MM-DD.log`
- **Console output**: Prefixed with `[SOCIAL_SCRAPE]` for easy identification

### Log Levels

- **DEBUG**: Detailed processing information, phone validation, etc.
- **INFO**: General progress information, file processing, completion status
- **WARN**: Non-critical issues, CSV parsing warnings
- **ERROR**: Critical errors, processing failures

### Log Rotation

- Logs are automatically rotated daily
- Maximum file size: 20MB
- Retention period: 30 days
- Automatic cleanup of old log files

## Performance Considerations

- The new compound index may slightly impact write performance but improves query performance
- Batch processing remains the same for optimal performance
- Memory usage is optimized with the same batching strategy
- Separate logging reduces I/O contention with other application logs

## Rollback Plan

If you need to rollback the changes:

1. Drop the compound unique index:
   ```javascript
   db.socialscrapes.dropIndex("url_1_date_1")
   ```

2. Recreate the unique index on URL only:
   ```javascript
   db.socialscrapes.createIndex({ url: 1 }, { unique: true })
   ```

3. Handle any duplicate records that may have been created

## Support

If you encounter any issues during migration or with the new import system:

1. Check the social scrape logs: `logs/social_scrape-YYYY-MM-DD.log`
2. Check error logs: `logs/social_scrape-error-YYYY-MM-DD.log`
3. Look for console output prefixed with `[SOCIAL_SCRAPE]`
4. The system includes comprehensive logging to help diagnose any problems 