const mongoose = require('mongoose');


const getCollectionStats = async (req, res) => {
    try {
        // Get all collections from the database
        const collections = await mongoose.connection.db.listCollections().toArray();
        const stats = [];

        // Get stats for each collection
        for (const collection of collections) {
            const collectionName = collection.name;
            const collectionStats = await mongoose.connection.db.command({ collStats: collectionName });

            // Get index information
            const indexes = await mongoose.connection.db.collection(collectionName).indexes();
            const indexInfo = indexes.map(index => ({
                name: index.name,
                keys: Object.keys(index.key),
                isUnique: !!index.unique
            }));

            stats.push({
                collectionName,
                documentCount: collectionStats.count,
                size: collectionStats.size,
                storageSize: collectionStats.storageSize,
                avgObjSize: collectionStats.avgObjSize,
                indexes: indexInfo,
                indexCount: collectionStats.nindexes
            });
        }

        res.json(stats);
    } catch (error) {
        console.error('Error fetching MongoDB stats:', error);
        res.status(500).json({
            error: 'Failed to fetch MongoDB statistics',
            details: error.message
        });
    }
};

module.exports = {
    getCollectionStats
}; 