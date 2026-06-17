global.crypto = require('crypto'); 
const fs = require('fs');
const { MongoClient } = require('mongodb');

async function run() {
    const client = new MongoClient('mongodb://127.0.0.1:27017');
    await client.connect();
    const db = client.db('web_postalwiki');
    const collection = db.collection('address_master_merged');

    console.log("Reading NOT ACTIVE POST CODES-2.csv...");
    
    let content = fs.readFileSync('NOT ACTIVE POST CODES-2.csv', 'utf-8');
    
    // Safely strip the hidden BOM character (\ufeff) if it exists
    if (content.charCodeAt(0) === 0xFEFF) {
        content = content.substring(1);
    }

    const lines = content.split(/\r?\n|\r/);
    const postcodes = new Set();

    for (let line of lines) {
        if (!line.trim()) continue;
        
        // Match your main script's regex splitting logic
        const parts = line.split(/[\t,]+/);
        if (parts.length < 2) continue;
        
        // Grab the second column (index 1) for the actual postcode
        let pc = parts[1].replace(/['"]+/g, '').trim().toUpperCase();
        
        if (pc && pc !== 'POSTCODE' && pc !== 'POST CODE') {
            postcodes.add(pc);
        }
    }

    const pcArray = Array.from(postcodes);
    console.log(`Loaded ${pcArray.length.toLocaleString()} unique codes. Finding 5 sample matches inside RM Master...`);

    if (pcArray.length === 0) {
        console.log("❌ No postcodes could be parsed. Check file structure.");
        await client.close();
        return;
    }

    const samples = [];
    const batchSize = 50000;

    // Fast indexed batch chunk queries
    for (let i = 0; i < pcArray.length; i += batchSize) {
        const batch = pcArray.slice(i, i + batchSize);
        const matches = await collection.find(
            { postcode: { $in: batch } },
            { projection: { postcode: 1, address: 1, district: 1 } }
        ).limit(5 - samples.length).toArray();

        samples.push(...matches);
        if (samples.length >= 5) break;
    }

    console.log("\n==================================================");
    console.log("🎯 SAMPLE RECORDS FOUND FOR PURGE:");
    console.log("==================================================");
    if (samples.length === 0) {
        console.log("No matching records found in RM Master.");
    } else {
        console.log(JSON.stringify(samples, null, 2));
    }
    console.log("==================================================\n");

    await client.close();
}

run().catch(console.error);
