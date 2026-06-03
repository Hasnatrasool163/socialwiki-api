# Company House Import System

This system provides CSV import functionality for UK Company House data, following the same architecture pattern as other features in the postalwiki_server.

## Features

- CSV file import with automatic processing
- Company data validation and cleaning
- Batch processing for memory efficiency
- Progress tracking with real-time updates
- Error handling and comprehensive logging
- File archiving after processing
- Search and pagination capabilities
- RESTful API endpoints

## CSV Format

The system expects CSV files with the following columns (based on UK Company House format):

- Column 0: `CompanyName` → Company name
- Column 1: `CompanyNumber` → Unique company identifier
- Column 4: `AddressLine1` → First line of registered address
- Column 5: `AddressLine2` → Second line of registered address
- Column 6: `PostTown` → Post town
- Column 9: `PostCode` → Postal code
- Column 11: `CompanyStatus` → Company status (Active, Dissolved, etc.)
- Column 14: `IncorporationDate` → Date in d/m/Y format

*Note: The column mapping matches the PHP implementation in db_export*

## File Structure

```
server/
├── models/
│   └── CompanyHouse.js              # Company House model with indexes
├── services/
│   └── CompanyHouse.service.js      # Import service logic
├── controllers/
│   └── CompanyHouse.controller.js   # API controller
├── routes/
│   └── companyHouseRoutes.js        # API routes
├── config/
│   └── loggers/
│       └── companyHouseLogger.js    # Dedicated logger
└── imports/
    └── company_house/               # CSV files directory
        └── completed_YYYY-MM-DD/    # Processed files
```

## API Endpoints

### Start Import
```
POST /api/company-house/import
```
Starts processing CSV files in the import directory.

**Headers:**
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

**Response:**
```json
{
  "success": true,
  "message": "Import started",
  "files": ["companies_house_data.csv"]
}
```

### Get Import Progress
```
GET /api/company-house/import-progress
```
Returns current import progress and status.

**Response:**
```json
{
  "success": true,
  "data": {
    "currentFile": "companies_house_data.csv",
    "processed": 1500,
    "total": 0,
    "upserted": 1200,
    "modified": 300,
    "errors": [],
    "isComplete": false,
    "isRunning": true
  }
}
```

### Stop Import
```
POST /api/company-house/stop-import
```
Stops the current import process.

**Response:**
```json
{
  "success": true,
  "message": "Import stopped successfully"
}
```

### Get Collection Stats
```
GET /api/company-house/stats
```
Returns the total number of companies in the collection.

**Response:**
```json
{
  "success": true,
  "stats": 4567890
}
```

### Get Paginated Data
```
GET /api/company-house/paginated?page=1&limit=100&searchCompany=example&searchNumber=12345&searchPostcode=SW1A&searchStatus=Active
```
Returns paginated company data with optional search filters.

**Query Parameters:**
- `page`: Page number (default: 1)
- `limit`: Items per page (default: 100)
- `searchCompany`: Search by company name
- `searchNumber`: Search by company number
- `searchPostcode`: Search by postcode
- `searchStatus`: Search by company status
- `useCursor`: Use cursor-based pagination for better performance
- `cursor`: Cursor for pagination

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "CompanyName": "EXAMPLE LTD",
      "CompanyNumber": "12345678",
      "RegAddress": {
        "AddressLine1": "123 Business Street",
        "AddressLine2": "",
        "PostTown": "LONDON",
        "PostCode": "SW1A 1AA"
      },
      "CompanyStatus": "Active",
      "IncorporationDate": "15/03/2020",
      "date": "2025-09-20T10:30:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 100,
    "total": 4567890,
    "hasMore": true,
    "nextCursor": "66e123456789abcdef123456"
  }
}
```

### Get Company by Number
```
GET /api/company-house/company/:companyNumber
```
Returns detailed information for a specific company.

**Response:**
```json
{
  "success": true,
  "data": {
    "CompanyName": "EXAMPLE LTD",
    "CompanyNumber": "12345678",
    "RegAddress": {
      "AddressLine1": "123 Business Street",
      "AddressLine2": "",
      "PostTown": "LONDON",
      "PostCode": "SW1A 1AA"
    },
    "CompanyStatus": "Active",
    "IncorporationDate": "15/03/2020",
    "date": "2025-09-20T10:30:00.000Z",
    "fullAddress": "123 Business Street, LONDON, SW1A 1AA"
  }
}
```

### Search Companies
```
GET /api/company-house/search?query=example&limit=10
```
Performs text search across company names.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "CompanyName": "EXAMPLE LTD",
      "CompanyNumber": "12345678",
      "RegAddress": {
        "PostCode": "SW1A 1AA",
        "PostTown": "LONDON"
      },
      "CompanyStatus": "Active",
      "score": 1.5
    }
  ],
  "count": 1
}
```

## Usage

1. Place CSV files in the `server/imports/company_house/` directory
2. Start the import process via API
3. Monitor progress using the progress endpoint
4. Processed files are automatically moved to `completed_YYYY-MM-DD/` subdirectories

## Data Processing

The system automatically:
- Validates required fields (CompanyName, CompanyNumber)
- Cleans and trims text data
- Parses dates in d/m/Y format
- Handles duplicate companies using upsert logic
- Creates nested address structure
- Adds import timestamp

## Error Handling

- CSV parsing errors are logged but don't stop the process
- Invalid records are logged and skipped
- Malformed records are logged and skipped
- Duplicate company numbers are handled with upsert logic

## Performance

- Batch size: 2000 records per batch
- Parallel processing: 2 batches at a time
- Memory efficient streaming for large files
- Indexed database queries for fast retrieval
- Cursor-based pagination for large datasets

## Model Schema

```javascript
{
  CompanyName: String,           // Required, trimmed
  CompanyNumber: String,         // Required, unique, trimmed
  RegAddress: {
    AddressLine1: String,
    AddressLine2: String,
    PostTown: String,
    PostCode: String
  },
  CompanyStatus: String,
  IncorporationDate: String,     // d/m/Y format
  date: Date,                    // Import date
  is_blacklisted: Boolean,       // Default: false
  createdAt: Date,              // Auto-generated
  updatedAt: Date               // Auto-generated
}
```

## Indexes

- Unique index on `CompanyNumber`
- Text index on `CompanyName` for search
- Index on `CompanyStatus` for filtering
- Index on `RegAddress.PostCode` for location queries
- Index on `date` for sorting
- Compound index on `CompanyName + RegAddress.PostCode`

## Logging

The system uses Winston for comprehensive logging:

- `logs/company_house/company-house.log` - General operations
- `logs/company_house/error-company-house.log` - Errors only
- `logs/company_house/company-house-debug.log` - Debug information

## Authentication

All import operations require admin authentication:
- Bearer token authentication
- Admin role authorization

## Testing

You can test the functionality by:

1. Adding sample CSV files to the import directory
2. Using the API endpoints to start import
3. Monitoring progress and checking logs
4. Verifying data in MongoDB

## Notes

- The system follows the same architecture as Botsol and SocialScrape features
- Date formats match the PHP implementation for consistency
- Company numbers are used as unique identifiers
- Files are processed sequentially but records are batched for efficiency
- The system handles missing or empty columns gracefully