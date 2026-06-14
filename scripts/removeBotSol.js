const mongoose = require('mongoose');
require('dotenv').config();

const Botsol = require('../models/Botsol');

const EXECUTE_CHANGES = false;

const run = async () => {
    try {
        console.log('Connecting to database...');
        await mongoose.connect(
            process.env.MONGO_URI ||
            'mongodb://127.0.0.1:27017/web_postalwiki'
        );

        console.log('Connected.\n');

        const totalRecords = await Botsol.countDocuments({});
        console.log(`Total records: ${totalRecords.toLocaleString()}\n`);

        // RULE 1
        console.log('================================================');
        console.log('RULE 1');
        console.log('URL + DATE + POSTCODE');
        console.log('================================================');

        const rule1 = await Botsol.aggregate([
            {
                $match: {
                    url: { $nin: ['', null] },
                    postcode: { $nin: ['', null] }
                }
            },
            {
                $group: {
                    _id: {
                        url: '$url',
                        date: '$date',
                        postcode: '$postcode'
                    },
                    count: { $sum: 1 }
                }
            },
            {
                $match: {
                    count: { $gt: 1 }
                }
            },
            {
                $group: {
                    _id: null,
                    duplicateGroups: { $sum: 1 },
                    recordsToRemove: {
                        $sum: { $subtract: ['$count', 1] }
                    }
                }
            }
        ]);

        const rule1Groups = rule1[0]?.duplicateGroups || 0;
        const rule1Removals = rule1[0]?.recordsToRemove || 0;

        console.log(`Duplicate groups : ${rule1Groups.toLocaleString()}`);
        console.log(`Records to remove: ${rule1Removals.toLocaleString()}\n`);

        const rule1Samples = await Botsol.aggregate([
            {
                $match: {
                    url: { $nin: ['', null] },
                    postcode: { $nin: ['', null] }
                }
            },
            {
                $group: {
                    _id: {
                        url: '$url',
                        date: '$date',
                        postcode: '$postcode'
                    },
                    count: { $sum: 1 }
                }
            },
            {
                $match: {
                    count: { $gt: 1 }
                }
            },
            { $limit: 3 }
        ]);

        console.log('Samples:');
        console.log(rule1Samples);

        // RULE 2

        console.log('\n================================================');
        console.log('RULE 2');
        console.log('URL EMPTY + DATE + COMPANY_NAME + POSTCODE');
        console.log('================================================');

        const rule2 = await Botsol.aggregate([
            {
                $match: {
                    $or: [
                        { url: '' },
                        { url: null },
                        { url: { $exists: false } }
                    ],
                    postcode: { $nin: ['', null] }
                }
            },
            {
                $group: {
                    _id: {
                        date: '$date',
                        company_name: '$company_name',
                        postcode: '$postcode'
                    },
                    count: { $sum: 1 }
                }
            },
            {
                $match: {
                    count: { $gt: 1 }
                }
            },
            {
                $group: {
                    _id: null,
                    duplicateGroups: { $sum: 1 },
                    recordsToRemove: {
                        $sum: { $subtract: ['$count', 1] }
                    }
                }
            }
        ]);

        const rule2Groups = rule2[0]?.duplicateGroups || 0;
        const rule2Removals = rule2[0]?.recordsToRemove || 0;

        console.log(`Duplicate groups : ${rule2Groups.toLocaleString()}`);
        console.log(`Records to remove: ${rule2Removals.toLocaleString()}\n`);

        const rule2Samples = await Botsol.aggregate([
            {
                $match: {
                    $or: [
                        { url: '' },
                        { url: null },
                        { url: { $exists: false } }
                    ],
                    postcode: { $nin: ['', null] }
                }
            },
            {
                $group: {
                    _id: {
                        date: '$date',
                        company_name: '$company_name',
                        postcode: '$postcode'
                    },
                    count: { $sum: 1 }
                }
            },
            {
                $match: {
                    count: { $gt: 1 }
                }
            },
            { $limit: 3 }
        ]);

        console.log('Samples:');
        console.log(rule2Samples);

        // RULE 3

        console.log('\n================================================');
        console.log('RULE 3');
        console.log('POSTCODE EMPTY + DATE + COMPANY_NAME + ADDRESS');
        console.log('================================================');

        const rule3 = await Botsol.aggregate([
            {
                $match: {
                    $or: [
                        { postcode: '' },
                        { postcode: null },
                        { postcode: { $exists: false } }
                    ]
                }
            },
            {
                $group: {
                    _id: {
                        date: '$date',
                        company_name: '$company_name',
                        address: '$address'
                    },
                    count: { $sum: 1 }
                }
            },
            {
                $match: {
                    count: { $gt: 1 }
                }
            },
            {
                $group: {
                    _id: null,
                    duplicateGroups: { $sum: 1 },
                    recordsToRemove: {
                        $sum: { $subtract: ['$count', 1] }
                    }
                }
            }
        ]);

        const rule3Groups = rule3[0]?.duplicateGroups || 0;
        const rule3Removals = rule3[0]?.recordsToRemove || 0;

        console.log(`Duplicate groups : ${rule3Groups.toLocaleString()}`);
        console.log(`Records to remove: ${rule3Removals.toLocaleString()}\n`);

        const rule3Samples = await Botsol.aggregate([
            {
                $match: {
                    $or: [
                        { postcode: '' },
                        { postcode: null },
                        { postcode: { $exists: false } }
                    ]
                }
            },
            {
                $group: {
                    _id: {
                        date: '$date',
                        company_name: '$company_name',
                        address: '$address'
                    },
                    count: { $sum: 1 }
                }
            },
            {
                $match: {
                    count: { $gt: 1 }
                }
            },
            { $limit: 3 }
        ]);

        console.log('Samples:');
        console.log(rule3Samples);

        console.log('\n================================================');
        console.log('SUMMARY');
        console.log('================================================');

        const totalRemovals =
            rule1Removals +
            rule2Removals +
            rule3Removals;

        console.log(`Rule 1 removals: ${rule1Removals.toLocaleString()}`);
        console.log(`Rule 2 removals: ${rule2Removals.toLocaleString()}`);
        console.log(`Rule 3 removals: ${rule3Removals.toLocaleString()}`);
        console.log('--------------------------------');
        console.log(`Potential removals: ${totalRemovals.toLocaleString()}`);
        console.log(`Remaining records : ${(totalRecords - totalRemovals).toLocaleString()}`);

        if (EXECUTE_CHANGES) {
            console.log('\nEXECUTE_CHANGES is TRUE');
            console.log('Delete logic not implemented yet.');
        }

    } catch (err) {
        console.error(err);
    } finally {
        await mongoose.connection.close();
        console.log('\nDatabase connection closed.');
    }
};

run();
