const addressPartsFromDoc = (address) => {
    if (typeof address === 'string' && address.startsWith('[')) {
        try {
            const parsed = JSON.parse(address);
            if (Array.isArray(parsed)) return parsed;
        } catch (e) {}
    }
    if (typeof address === 'string') {
        return address.split(',').map(p => p.trim()).filter(Boolean);
    }
    return [];
};

const normalizePostcode = (value) => {
    if (!value) return '';
    const compact = value.toString().trim().toUpperCase().replace(/\s+/g, ' ').replace(/[^A-Z0-9 ]/g, '');
    if (!compact) return '';
    const noSpace = compact.replace(/\s+/g, '');
    if (noSpace.length > 3) {
        return `${noSpace.slice(0, noSpace.length - 3)} ${noSpace.slice(noSpace.length - 3)}`;
    }
    return compact;
};

module.exports = { addressPartsFromDoc, normalizePostcode };