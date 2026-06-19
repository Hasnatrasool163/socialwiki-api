const mongoose = require('mongoose');

async function fixEncoding() {
    await mongoose.connect('mongodb://localhost:27017/web_postalwiki');
    const collection = mongoose.connection.db.collection('address_master_merged');

    // Find all records containing the HTML entity
    const cursor = collection.find({ address: { $regex: /&#39;/ } });

    let count = 0;
    while (await cursor.hasNext()) {
        const doc = await cursor.next();
        const newAddress = doc.address.replace(/&#39;/g, "'");
        
        await collection.updateOne(
            { _id: doc._id },
            { $set: { address: newAddress } }
        );
        count++;
    }

    console.log(`✨ Fixed encoding for ${count} records.`);
    await mongoose.disconnect();
}

fixEncoding().catch(console.error);
