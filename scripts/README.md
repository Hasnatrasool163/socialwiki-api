# Database Scripts

This directory contains utility scripts for database operations.

## trimFields.js

This script trims the `title`, `keywords`, and `meta_description` fields in the `socialscrapes` collection to a maximum of 400 characters.

### Features

- Processes records in batches of 1000 to avoid memory issues
- Only updates records that actually need trimming
- Logs all updated record URLs to a dedicated log file
- Provides progress updates during execution
- Uses bulk operations for efficient database updates

### Usage

From the server directory, run:

```bash
npm run trim-fields
```

Or directly:

```bash
node scripts/trimFields.js
```

### Logging

The script creates a dedicated log file at `logs/trim-fields-YYYY-MM-DD.log` that includes:
- Script start/completion information
- Progress updates for each batch
- URLs of all records that were updated
- Final statistics (total processed, total updated, percentage)

### Configuration

You can modify these constants in the script:
- `MAX_CHAR_LIMIT`: Maximum character limit (default: 400)
- `BATCH_SIZE`: Number of records to process per batch (default: 1000)

### Safety

- The script only updates records that actually need trimming
- It uses bulk operations for efficiency
- Includes error handling and graceful shutdown
- Logs all operations for audit purposes 