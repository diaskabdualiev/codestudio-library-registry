const fs = require('fs/promises');
const path = require('path');

// Use dynamic import for node-fetch
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- Configuration ---
const LIBRARY_INDEX_URL = 'https://downloads.arduino.cc/libraries/library_index.json';
const OUTPUT_FILE = path.join(__dirname, 'registry.json');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const MAX_RETRIES = 3;           // Max retries for rate limit
const FETCH_TIMEOUT_MS = 30000;  // 30 second timeout for requests
const CONCURRENT_REQUESTS = 5;   // Parallel GitHub API requests

if (!GITHUB_TOKEN) {
    console.warn("Warning: GITHUB_TOKEN is not set. You may hit rate limits quickly.");
}

const headers = {
    'Accept': 'application/vnd.github.v3+json',
};
if (GITHUB_TOKEN) {
    headers['Authorization'] = `token ${GITHUB_TOKEN}`;
}

// --- Utility Functions ---

// Fetch with timeout
const fetchWithTimeout = async (url, options = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        return response;
    } finally {
        clearTimeout(timeout);
    }
};

// Retry wrapper for any async function
const withRetry = async (fn, maxRetries = MAX_RETRIES, context = '') => {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                const delay = Math.min(1000 * Math.pow(2, attempt), 10000); // Exponential backoff, max 10s
                console.warn(`::warning::${context} Attempt ${attempt}/${maxRetries} failed: ${error.message}. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
};

// Extracts owner/repo from various GitHub URL formats
const parseGitHubUrl = (url) => {
    if (!url) return null;
    const match = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/);
    return match ? { owner: match[1], repo: match[2].replace(/\.git$/, '') } : null;
};

// Compare semver versions (returns negative if a < b, positive if a > b, 0 if equal)
const compareSemver = (a, b) => {
    const parseVersion = (v) => {
        const match = v.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
        if (!match) return [0, 0, 0];
        return [
            parseInt(match[1], 10) || 0,
            parseInt(match[2], 10) || 0,
            parseInt(match[3], 10) || 0
        ];
    };

    const [aMajor, aMinor, aPatch] = parseVersion(a);
    const [bMajor, bMinor, bPatch] = parseVersion(b);

    if (aMajor !== bMajor) return bMajor - aMajor; // Descending
    if (aMinor !== bMinor) return bMinor - aMinor;
    return bPatch - aPatch;
};

// Fetches rich data from GitHub API with smart rate limit handling
const fetchGitHubData = async (repoInfo, retryCount = 0) => {
    if (!repoInfo) return null;

    const apiUrl = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}`;

    try {
        const response = await fetchWithTimeout(apiUrl, { headers });

        // Handle rate limiting
        if (response.status === 403 || response.status === 429) {
            if (retryCount >= MAX_RETRIES) {
                console.error(`::error::Rate limit: Max retries (${MAX_RETRIES}) exceeded for ${repoInfo.owner}/${repoInfo.repo}`);
                return null;
            }

            const rateLimitReset = response.headers.get('x-ratelimit-reset');
            let waitTimeSec = 60; // Default wait time

            if (rateLimitReset) {
                const resetTimeMs = parseInt(rateLimitReset, 10) * 1000;
                waitTimeSec = Math.max(0, (resetTimeMs - Date.now()) / 1000) + 1;
            }

            console.warn(`::warning::Rate limit hit. Waiting ${Math.ceil(waitTimeSec)}s (attempt ${retryCount + 1}/${MAX_RETRIES})...`);
            await new Promise(resolve => setTimeout(resolve, waitTimeSec * 1000));

            return await fetchGitHubData(repoInfo, retryCount + 1);
        }

        if (response.status === 404) {
            // Repo not found - treat as archived
            return { stars: 0, isArchived: true, error: 'not_found' };
        }

        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        return {
            stars: data.stargazers_count ?? 0,
            isArchived: data.archived ?? false,
            pushedAt: data.pushed_at,
            openIssues: data.open_issues_count ?? 0,
            description: data.description,
            license: data.license?.spdx_id ?? null,
            topics: data.topics ?? [],
        };
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error(`::error::Timeout fetching ${repoInfo.owner}/${repoInfo.repo}`);
        } else {
            console.error(`::error::Error fetching GitHub data for ${repoInfo.owner}/${repoInfo.repo}: ${error.message}`);
        }
        return null;
    }
};

// Process libraries in batches with concurrency control
const processInBatches = async (items, batchSize, processor) => {
    const results = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(processor));
        results.push(...batchResults);

        // Log progress
        const processed = Math.min(i + batchSize, items.length);
        if (processed % 50 === 0 || processed === items.length) {
            console.log(`Processed ${processed}/${items.length} libraries...`);
        }
    }
    return results;
};

// Main generation function
const generateRegistry = async () => {
    console.log("Starting registry generation...");

    // 1. Fetch main library index with retry
    console.log("Fetching Arduino library index...");
    const indexData = await withRetry(async () => {
        const response = await fetchWithTimeout(LIBRARY_INDEX_URL);
        if (!response.ok) {
            throw new Error(`Failed to fetch Arduino library index: ${response.status}`);
        }
        return response.json();
    }, MAX_RETRIES, '[Arduino API]');

    // Validate response structure
    if (!indexData || !Array.isArray(indexData.libraries)) {
        throw new Error("Invalid Arduino library index format: 'libraries' array not found");
    }

    const rawLibraries = indexData.libraries;
    console.log(`Found ${rawLibraries.length} raw library entries.`);

    // 2. Group libraries by name
    console.log("Grouping libraries by name...");
    const librariesMap = new Map();

    for (const lib of rawLibraries) {
        if (!lib || !lib.name) {
            console.warn("::warning::Skipping invalid library entry (missing name)");
            continue;
        }

        const versionInfo = {
            version: lib.version,
            url: lib.url,
            archiveFileName: lib.archiveFileName,
            size: lib.size,
            checksum: lib.checksum,
        };

        if (!librariesMap.has(lib.name)) {
            const repoInfo = parseGitHubUrl(lib.website) || parseGitHubUrl(lib.repository);
            librariesMap.set(lib.name, {
                name: lib.name,
                author: lib.author,
                maintainer: lib.maintainer,
                sentence: lib.sentence,
                paragraph: lib.paragraph,
                website: lib.website,
                category: lib.category,
                architectures: lib.architectures,
                types: lib.types,
                repository: repoInfo ? `https://github.com/${repoInfo.owner}/${repoInfo.repo}` : null,
                _repoInfo: repoInfo,
                versions: [versionInfo],
            });
        } else {
            librariesMap.get(lib.name).versions.push(versionInfo);
        }
    }

    let uniqueLibraries = Array.from(librariesMap.values());
    console.log(`Grouped into ${uniqueLibraries.length} unique libraries.`);

    // 3. Sort versions by semver (newest first)
    for (const lib of uniqueLibraries) {
        lib.versions.sort((a, b) => compareSemver(a.version, b.version));
    }

    // 4. Enrich unique libraries with GitHub data (with concurrency)
    console.log(`Enriching libraries with GitHub data (${CONCURRENT_REQUESTS} concurrent requests)...`);

    const enrichedLibraries = await processInBatches(
        uniqueLibraries,
        CONCURRENT_REQUESTS,
        async (lib) => {
            if (lib._repoInfo) {
                const githubData = await fetchGitHubData(lib._repoInfo);
                if (githubData) {
                    lib.stars = githubData.stars;
                    lib.isArchived = githubData.isArchived;
                    lib.pushedAt = githubData.pushedAt;
                    lib.openIssues = githubData.openIssues;
                    lib.githubDescription = githubData.description;
                    lib.license = githubData.license;
                    lib.topics = githubData.topics;
                }
            } else {
                console.warn(`::warning::[Skipping] No GitHub URL for library: ${lib.name}`);
            }
            delete lib._repoInfo;
            return lib;
        }
    );

    // 5. Filter and sort the final list
    console.log("Filtering and sorting the final registry...");
    const finalRegistry = enrichedLibraries
        .filter(lib => lib.repository && !lib.isArchived)
        .sort((a, b) => {
            // Handle undefined/null stars
            const starsA = a.stars ?? 0;
            const starsB = b.stars ?? 0;
            if (starsB !== starsA) return starsB - starsA;
            return a.name.localeCompare(b.name);
        });

    console.log(`Final registry contains ${finalRegistry.length} active libraries.`);

    // 6. Save to file
    const output = {
        generatedAt: new Date().toISOString(),
        totalLibraries: finalRegistry.length,
        libraries: finalRegistry,
    };

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2));
    console.log(`Successfully wrote registry to ${OUTPUT_FILE}`);
};

// --- Run the script ---
generateRegistry().catch(error => {
    console.error(`::error::FATAL: Registry generation failed. ${error.message}`);
    process.exit(1);
});
