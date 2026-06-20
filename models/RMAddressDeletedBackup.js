const mongoose = require('mongoose');

const RMAddressDeletedBackupSchema = new mongoose.Schema({
    exportJobId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    originalId: { type: mongoose.Schema.Types.ObjectId, required: true },
    postcode: String,
    district: String,
    address: String,           
    dateCreated: String,
    correctionVersion: String,
    exceptionVersion: String,
    status: { type: String, enum: ['exported', 'reimported'], default: 'exported', index: true },
    reimportJobId: { type: mongoose.Schema.Types.ObjectId, default: null }
}, {
    collection: 'rm_address_deleted_backups',
    timestamps: true
});

module.exports = mongoose.model('RMAddressDeletedBackup', RMAddressDeletedBackupSchema);