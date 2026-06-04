const fs = require('fs');
const path = require('path');

const PostcodeDistrict = require('../models/PostcodeDistrict');
const postcodeLogger = require('../config/loggers/postcodeDistrictLogger');

const REPORT_DIR = path.join(__dirname, '../imports/reports/missing-postcodes');
const REPORT_FILE_PREFIX = 'missing-postcodes';

const ensureReportDirectory = async () => {
    await fs.promises.mkdir(REPORT_DIR, { recursive: true });
};

const writeLine = async (stream, line) => {
    if (stream.write(line)) {
        return;
    }

    await new Promise((resolve) => stream.once('drain', resolve));
};

const buildMissingPostcodesPipeline = () => ([
    {
        $match: {
            district: { $ne: 'NOT ACTIVE' }
        }
    },
    {
        $lookup: {
            from: 'address_main',
            localField: 'postcode',
            foreignField: 'postcode',
            as: 'addressMatches'
        }
    },
    {
        $match: {
            'addressMatches.0': { $exists: false }
        }
    },
    {
        $project: {
            _id: 0,
            postcode_1: '$postcode'
        }
    },
    {
        $sort: {
            postcode_1: 1
        }
    }
]);

exports.downloadMissingPostcodesReport = async (req, res) => {
    const generatedAt = new Date();
    const fileName = `${REPORT_FILE_PREFIX}-${generatedAt.toISOString().replace(/[:.]/g, '-')}.csv`;
    const filePath = path.join(REPORT_DIR, fileName);

    let outputStream;

    try {
        await ensureReportDirectory();

        outputStream = fs.createWriteStream(filePath, { encoding: 'utf8' });

        const cursor = PostcodeDistrict.aggregate(buildMissingPostcodesPipeline())
            .allowDiskUse(true)
            .cursor({ batchSize: 1000 })
            .exec();

        let missingCount = 0;

        for await (const row of cursor) {
            const postcode = (row?.postcode_1 || '').toString().trim();
            if (!postcode) {
                continue;
            }

            missingCount += 1;
            await writeLine(outputStream, `${postcode}\n`);
        }

        await new Promise((resolve, reject) => {
            outputStream.end(() => resolve());
            outputStream.once('error', reject);
        });

        postcodeLogger.info(`Missing postcode report generated: ${fileName} (${missingCount} rows)`);

        res.setHeader('X-Report-File-Name', fileName);
        res.setHeader('X-Report-File-Path', filePath);
        res.setHeader('X-Report-Download-Location', `/imports/reports/missing-postcodes/${fileName}`);

        return res.download(filePath, fileName, (downloadError) => {
            if (downloadError) {
                postcodeLogger.error(`Failed to download missing postcode report ${fileName}: ${downloadError.message}`);
            }
        });
    } catch (error) {
        postcodeLogger.error(`Error generating missing postcode report: ${error.message}`);

        if (outputStream && !outputStream.destroyed) {
            outputStream.destroy();
        }

        await fs.promises.unlink(filePath).catch(() => undefined);

        return res.status(500).json({
            success: false,
            message: 'Failed to generate missing postcode report'
        });
    }
};