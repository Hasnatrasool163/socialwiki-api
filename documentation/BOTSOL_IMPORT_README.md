# Botsol Import System

This system provides CSV import functionality for the Botsol collection, similar to the SocialScrape import system.

## Features

- CSV file import with automatic processing
- Phone number validation and formatting
- Social media URL cleaning
- Address parsing with postcode extraction
- Batch processing for memory efficiency
- Progress tracking
- Error handling and logging
- File archiving after processing

## CSV Format

The system expects CSV files with the following columns:

- `Name` → `company_name`
- `Full_Address` → `address`
- `Website` or `URL` → `url`
- `Phone` → `phone` (formatted with area codes)
- `Email` → `email`
- `Description` → `meta_description`
- `Facebook` → `facebook`
- `Twitter` → `twitter`
- `Instagram` → `instagram`

## File Structure

```
server/
├── models/
│   └── Botsol.js                 # Botsol model with indexes
├── services/
│   └── Botsol.service.js         # Import service logic
├── controllers/
│   └── botsolController.js       # API controller
├── routes/
│   └── botsolRoutes.js           # API routes
└── imports/
    └── botsol/                   # CSV files directory
        └── completed_YYYY-MM-DD/ # Processed files
```

## API Endpoints

### Start Import
```
POST /api/botsol/import
```
Starts processing CSV files in the import directory.

### Get Import Progress
```
GET /api/botsol/import-progress
```
Returns current import progress and status.

### Stop Import
```
POST /api/botsol/stop-import
```
Stops the current import process.

### Get Collection Stats
```
GET /api/botsol/stats
```
Returns the total number of documents in the collection.

### Get Paginated Data
```
GET /api/botsol/paginated?page=1&limit=100&searchUrl=example.com&searchCompany=company
```
Returns paginated Botsol data with optional search filters.

## Usage

1. Place CSV files in the `server/imports/botsol/` directory
2. Start the import process via API
3. Monitor progress using the progress endpoint
4. Processed files are automatically moved to `completed_YYYY-MM-DD/` subdirectories

## Phone Number Processing

The system automatically:
- Cleans phone numbers (removes spaces, dashes, brackets)
- Handles scientific notation
- Formats UK phone numbers
- Adds area code information
- Validates phone number format

## Error Handling

- CSV parsing errors are logged but don't stop the process
- Invalid domains are skipped
- Malformed records are logged and skipped
- Duplicate records are handled with upsert logic

## Performance

- Batch size: 2000 records per batch
- Parallel processing: 2 batches at a time
- Memory efficient streaming for large files
- Indexed database queries for fast retrieval

## Model Schema

```javascript
{
  company_name: String,
  url: String,
  date: Date,
  address: String,
  email: String,
  phone: [{
    number: String,
    areaName: String
  }],
  facebook: String,
  twitter: String,
  instagram: String,
  meta_description: String,
  postcode: String,
  is_blacklisted: Boolean
}
```

## Indexes

- Compound unique index on `url + date`
- Index on `date` for sorting
- Index on `phone.number` for search
- Text indexes on `url` and `company_name` for search

## Testing

Run the test script to verify functionality:
```bash
node test_botsol_import.js
```

## Notes

- File creation dates are used as record dates when available
- Postcodes are automatically extracted from addresses
- Social media URLs are cleaned and normalized
- The system handles missing or empty columns gracefully 