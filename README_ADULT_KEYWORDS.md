# Adult Keywords Matching System

This system provides functionality to automatically detect and handle adult content in social scrape data by matching against predefined keyword lists.

## Overview

The system processes CSV files from the `server/update/social_scrape/match_adult_keywords/` directory and performs two types of matching:

1. **Exact Match**: If any URL contains exact adult keywords, it automatically updates the corresponding social scrape record
2. **Contains Match**: If any URL contains partial adult keywords, it creates a reference for manual review

## Features

- **Automatic Processing**: Batch processing of CSV files with progress tracking
- **Dual Matching Strategy**: Exact and partial keyword matching
- **Database Updates**: Automatic updates to social scrape records for exact matches
- **Reference Creation**: Creates references for manual review of partial matches
- **Progress Tracking**: Real-time progress monitoring with detailed statistics
- **Error Handling**: Comprehensive error handling and logging

## API Endpoints

### Base URL: `/api/adult-keywords`

#### Public Routes (No Auth Required)
- `GET /matching-progress` - Get current matching progress

#### Protected Routes (Admin Only)
- `POST /start-matching` - Start the adult keywords matching process
- `POST /stop-matching` - Stop the current matching process
- `GET /stats` - Get matching statistics
- `GET /references` - Get all adult keywords references
- `GET /references/paginated` - Get paginated references with filters

## Usage

### 1. Prepare CSV Files

Place your CSV files in the `server/update/social_scrape/match_adult_keywords/` directory. The CSV should have the same structure as social import files with columns:
- `url`
- `title`
- `meta_description`
- `keywords`

### 2. Start Matching Process

```bash
POST /api/adult-keywords/start-matching
```

This will:
- Check for CSV files in the directory
- Start processing them in batches
- Update social scrape records for exact matches
- Create references for partial matches

### 3. Monitor Progress

```bash
GET /api/adult-keywords/matching-progress
```

Returns current progress including:
- Current file being processed
- Total records processed
- Exact matches found
- Contains matches found
- Records updated
- References created
- Any errors encountered

### 4. View Statistics

```bash
GET /api/adult-keywords/stats
```

Returns overall statistics including:
- Total references in database
- Unprocessed references
- Match type breakdowns
- Current progress status

### 5. Review References

```bash
GET /api/adult-keywords/references/paginated?page=1&limit=50&matchType=contains&processed=false
```

Returns paginated references for manual review with filtering options:
- `page`: Page number (default: 1)
- `limit`: Records per page (default: 50)
- `matchType`: Filter by match type (`exact` or `contains`)
- `processed`: Filter by processed status (`true` or `false`)

## How It Works

### 1. Exact Match Processing

When a record contains exact adult keywords:
- System checks if the URL exists in social scrape database
- If found, automatically updates title, meta_description, and keywords to "Possible 18+ content – text / image removed"
- If not found, the record is ignored

### 2. Contains Match Processing

When a record contains partial adult keywords:
- System creates a reference in the `adultkeywordsreferences` collection
- These references are available for manual review
- Users can decide whether to update the corresponding social scrape records

### 3. File Processing

- CSV files are processed in batches of 1000 records
- Completed files are moved to a `completed_YYYY-MM-DD` subdirectory
- Progress is tracked in real-time
- Errors are logged and processing continues with remaining files

## Database Collections

### `adultkeywordsreferences`

Stores references for URLs that contain partial adult keywords:

```javascript
{
  url: String,
  title: String,
  meta_description: String,
  keywords: String,
  matched_keywords: [String],
  match_type: 'exact' | 'contains',
  csv_source: String,
  processed: Boolean,
  processed_at: Date,
  created_at: Date
}
```

## Configuration

### Keyword Lists

The system uses two keyword lists from `server/utils/adult_keywords.js`:

- `adultKeywords_exact_match`: Exact phrases that trigger immediate updates
- `adultKeywords_contains`: Partial words that create references for review

### Batch Processing

- **Batch Size**: 1000 records per batch
- **Directory**: `server/update/social_scrape/match_adult_keywords/`
- **Completed Files**: Moved to `completed_YYYY-MM-DD/` subdirectory

## Error Handling

- CSV parsing errors are logged but don't stop processing
- Database errors are logged with full context
- Network timeouts are handled gracefully
- Progress tracking continues even if individual records fail

## Logging

All operations are logged using the `socialScrapeLogger` with appropriate log levels:
- `info`: Normal operations and progress updates
- `warn`: Non-critical issues (e.g., URLs not found)
- `error`: Critical errors that need attention

## Security

- All endpoints require admin authentication
- Uses existing role-based access control
- Input validation and sanitization
- No sensitive data exposure in logs

## Testing

Run the test script to verify functionality:

```bash
node test_adult_keywords.js
```

This will test all service methods and verify database connectivity.

## Troubleshooting

### Common Issues

1. **No CSV files found**: Ensure files are in the correct directory with `.csv` extension
2. **Database connection errors**: Check MongoDB connection and credentials
3. **Permission errors**: Verify file system permissions for the match directory
4. **Memory issues**: Reduce batch size if processing large files

### Monitoring

- Check application logs for detailed error information
- Monitor database performance during large file processing
- Use progress endpoints to track long-running operations
- Review reference collection for manual review items 