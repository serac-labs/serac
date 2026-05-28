/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://serac.build",

  // GitHub
  github: {
    repoUrl: "https://github.com/serac-labs/serac",
    starsFormatted: {
      compact: "80K",
      full: "80,000",
    },
  },

  // Social links
  social: {
    twitter: "https://x.com/snowflowdev",
    discord: "https://discord.gg/uGGrWj9KsT",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "600",
    commits: "7,500",
    monthlyUsers: "1.5M",
  },
} as const
