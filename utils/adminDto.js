/**
 * adminDto.js
 * 
 * Strict allow-list DTO transformation layer.
 * Strictly prevents leaking sensitive fields:
 * - password
 * - verificationTokenHash, verificationTokenExpires
 * - resetPasswordTokenHash, resetPasswordTokenExpires
 * - pendingEmailTokenHash, pendingEmailTokenExpires
 * - refreshTokenFamily
 * - distinctPostcodes, distinctRecords
 * - userAgent
 * - ipRisk
 */

function toUserSummaryDTO(doc, extras = {}) {
    if (!doc) return null;
    const u = doc.toObject ? doc.toObject() : doc;
    return {
        _id: u._id,
        username: u.username,
        email: u.email || null,
        role: u.role,
        level: u.level,
        plan: u.plan,
        isVerified: !!u.isVerified,
        emailVerifiedAt: u.emailVerifiedAt || null,
        isApproved: !!u.isApproved,
        approvedAt: u.approvedAt || null,
        approvedBy: u.approvedBy || null,
        isBlocked: !!u.isBlocked,
        blockedAt: u.blockedAt || null,
        blockedBy: u.blockedBy || null,
        blockReason: u.blockReason || null,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        // Computed summaries
        lastActive: extras.lastActive || null,
        searchesThisMonth: extras.searchesThisMonth || 0
    };
}

function toUserDetailDTO(doc, extras = {}) {
    if (!doc) return null;
    const u = doc.toObject ? doc.toObject() : doc;
    return {
        _id: u._id,
        username: u.username,
        email: u.email || null,
        role: u.role,
        level: u.level,
        plan: u.plan,
        isVerified: !!u.isVerified,
        emailVerifiedAt: u.emailVerifiedAt || null,
        isApproved: !!u.isApproved,
        approvedAt: u.approvedAt || null,
        approvedBy: u.approvedBy || null,
        isBlocked: !!u.isBlocked,
        blockedAt: u.blockedAt || null,
        blockedBy: u.blockedBy || null,
        blockReason: u.blockReason || null,
        probationUntil: u.probationUntil || null,
        trialStartedAt: u.trialStartedAt || null,
        trialReactivatedAt: u.trialReactivatedAt || null,
        reactivationCount: u.reactivationCount || 0,
        savedDatabases: u.savedDatabases || [],
        historyMode: u.historyMode || 'latest',
        searchCount: u.searchCount || 0,
        searchResetDate: u.searchResetDate || null,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        // Allow-listed extras (IP shown ONLY on account detail page)
        recentIp: extras.recentIp || null,
        allowance: extras.allowance || null,
        monthlyUsage: extras.monthlyUsage || [],
        last30DaysDaily: extras.last30DaysDaily || [],
        last50Searches: extras.last50Searches || []
    };
}

function toSearchEventDTO(doc) {
    if (!doc) return null;
    const s = doc.toObject ? doc.toObject() : doc;
    return {
        _id: s._id,
        time: s.time,
        normalizedQuery: s.normalizedQuery,
        queryType: s.queryType,
        datasetsSearched: s.datasetsSearched || [],
        totalResults: s.totalResults || 0,
        found: !!s.found,
        searchSessionId: s.searchSessionId || null
    };
}

function toUsageDailyDTO(doc) {
    if (!doc) return null;
    const item = doc.toObject ? doc.toObject() : doc;
    return {
        _id: item._id,
        userId: item.userId || null,
        date: item.date,
        plan: item.plan,
        searchCount: item.searchCount || 0,
        sessionCount: item.sessionCount || 0,
        rowCount: item.rowCount || 0,
        distinctPostcodeCount: item.distinctPostcodeCount || (item.distinctPostcodes ? item.distinctPostcodes.length : 0),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
    };
}

function toNotFoundDTO(doc) {
    if (!doc) return null;
    const item = doc.toObject ? doc.toObject() : doc;
    return {
        _id: item._id,
        normalizedQuery: item.normalizedQuery,
        queryType: item.queryType,
        count: item.count || 0,
        firstSeen: item.firstSeen,
        lastSeen: item.lastSeen,
        status: item.status,
        notes: item.notes || '',
        sampleUserIds: item.sampleUserIds || [],
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
    };
}

module.exports = {
    toUserSummaryDTO,
    toUserDetailDTO,
    toSearchEventDTO,
    toUsageDailyDTO,
    toNotFoundDTO
};
