const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '../logs');
const today = '2025-12-28';

console.log(`Cleaning up logs in ${logsDir} not matching ${today}...`);

function cleanDirectory(directory) {
    if (!fs.existsSync(directory)) return;

    const files = fs.readdirSync(directory);

    files.forEach(file => {
        const filePath = path.join(directory, file);
        const stats = fs.statSync(filePath);

        if (stats.isDirectory()) {
            cleanDirectory(filePath);
        } else {
            // Logic to identify old files
            let shouldDelete = false;

            // 1. Audit files in file root (misplaced) -> Delete all
            // 2. Audit files in subdirs -> Delete if they look like audit files (user wants cleanup)
            // Actually, keep safe: 
            // - If it ends in .log
            //   - If it has a date pattern YYYY-MM-DD
            //     - If date != today -> Delete
            //   - If NO date pattern (e.g. app.log) -> Keep (active)
            // - If it ends in -audit.json
            //   - If in logs root -> Delete (cleanup)
            //   - If in subdir -> Delete? The user said "logs file of previous logs". 
            //     If we delete the log, we can delete the audit line? 
            //     Simple approach: Delete ALL audit files in root (requested fix). 
            //     In subdirs, maybe keep for now unless user insists, or delete if we are unsure.
            //     User said "delete all unnecessary old logs file".

            const isLogFile = file.endsWith('.log');
            const isAuditFile = file.includes('audit.json');

            if (isLogFile) {
                const dateMatch = file.match(/\d{4}-\d{2}-\d{2}/);
                if (dateMatch) {
                    const fileDate = dateMatch[0];
                    if (fileDate !== today) {
                        shouldDelete = true;
                    }
                }
                // If it's a rotated log without date? Winston usually adds date.
            } else if (isAuditFile) {
                // Delete audit files in root as they are misplaced/superfluous now
                if (directory === logsDir) {
                    shouldDelete = true;
                }
            }

            if (shouldDelete) {
                try {
                    fs.unlinkSync(filePath);
                    console.log(`Deleted: ${filePath}`);
                } catch (e) {
                    console.error(`Failed to delete ${filePath}:`, e.message);
                }
            }
        }
    });
}

cleanDirectory(logsDir);
console.log('Cleanup complete.');
