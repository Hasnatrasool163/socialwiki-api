/**
 * tierConstants.js
 * 
 * Single source of truth for subscription levels, plan identifiers,
 * rate limits, quotas, and dataset entitlements.
 * Shared between rate limiters, admin controllers, and frontend reference views.
 */

const TIER_CONSTANTS = {
    free: {
        level: 'free',
        plan: 'free',
        label: 'Free',
        dailySearchLimit: 5,
        weeklySearchLimit: 35,
        monthlySearchLimit: 150,
        rmTrialWeeks: 8,
        advTrialWeeks: 1,
        description: '5 searches/day (RM: 8 weeks; Multi-DB: 1 week preview)',
        datasets: ['RM (preview)', 'Limited Multi-DB (1 week preview)'],
        badgeVariant: 'secondary'
    },
    trial: {
        level: 'free',
        plan: 'trial',
        label: 'Free Trial',
        dailySearchLimit: 5,
        weeklySearchLimit: 35,
        monthlySearchLimit: 150,
        rmTrialWeeks: 8,
        advTrialWeeks: 1,
        description: '5 searches/day (Initial 8-week trial)',
        datasets: ['RM (preview)', 'Limited Multi-DB (1 week preview)'],
        badgeVariant: 'secondary'
    },
    level1: {
        level: 'level1',
        plan: 'level1',
        label: 'Level 1',
        dailySearchLimit: 20,
        weeklySearchLimit: 60,
        monthlySearchLimit: 260,
        description: '20 searches/day, 60 searches/week',
        datasets: ['RM address lookup only'],
        badgeVariant: 'emerald'
    },
    level2: {
        level: 'level2',
        plan: 'level2',
        label: 'Level 2 (1,000 a month)',
        dailySearchLimit: 100,
        weeklySearchLimit: 700,
        monthlySearchLimit: 1000,
        description: '100 searches/day fair-use, 1,000 searches/month',
        datasets: ['RM', 'Property Prices', 'Company House', 'Social Footprints', 'Businesses'],
        badgeVariant: 'blue'
    },
    level2_high: {
        level: 'level2_high',
        plan: 'level2_high',
        label: 'Level 2 high (3,000 a month)',
        dailySearchLimit: 300,
        weeklySearchLimit: 2100,
        monthlySearchLimit: 3000,
        description: '300 searches/day fair-use, 3,000 searches/month',
        datasets: ['RM', 'Property Prices', 'Company House', 'Social Footprints', 'Businesses'],
        badgeVariant: 'indigo'
    },
    business: {
        level: 'business',
        plan: 'paid', // Limiters read 'paid' for business level!
        label: 'Business',
        dailySearchLimit: 500,
        weeklySearchLimit: 3500,
        monthlySearchLimit: 15000,
        description: '500+ searches/day (High-volume / Custom)',
        datasets: ['All datasets & bulk API exports'],
        badgeVariant: 'amber'
    }
};

/**
 * Mapping table from level selection to { level, plan }
 * Admin is explicitly omitted (cannot assign admin role or tier via level change).
 */
const LEVEL_PLAN_MAPPING = {
    free:        { level: 'free',        plan: 'free' },
    trial:       { level: 'free',        plan: 'trial' },
    level1:      { level: 'level1',      plan: 'level1' },
    level2:      { level: 'level2',      plan: 'level2' },
    level2_high: { level: 'level2_high', plan: 'level2_high' },
    business:    { level: 'business',    plan: 'paid' }
};

module.exports = {
    TIER_CONSTANTS,
    LEVEL_PLAN_MAPPING
};
