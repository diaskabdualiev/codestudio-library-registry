const fs = require('fs/promises');
const path = require('path');

// Use dynamic import for node-fetch
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const LIBRARY_INDEX_URL = 'https://downloads.arduino.cc/libraries/library_index.json';
const OUTPUT_FILE = path.join(__dirname, 'registry.json');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

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

// Extracts owner/repo from various GitHub URL formats
const parseGitHubUrl = (url) => {
    if (!url) return null;
    const match = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/);
    return match ? { owner: match[1], repo: match[2].replace(/\.git$/, '') } : null;
};

// Fetches rich data from GitHub API
const fetchGitHubData = async (repoInfo) => {
    if (!repoInfo) return null;
    const apiUrl = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}`;
    try {
        const response = await fetch(apiUrl, { headers });
        if (response.status === 404) {
            console.warn(`[404 Not Found] Repo not found on GitHub: ${repoInfo.owner}/${repoInfo.repo}`);
            return { stars: 0, isArchived: true, error: 'not_found' }; // Treat 404 as "archived" to penalize it
        }
        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return {
            stars: data.stargazers_count,
            isArchived: data.archived,
            pushedAt: data.pushed_at,
            openIssues: data.open_issues_count,
            description: data.description,
            license: data.license ? data.license.spdx_id : null, // Extract SPDX ID
            topics: data.topics || [],
        };
    } catch (error) {
        console.error(`Error fetching GitHub data for ${repoInfo.owner}/${repoInfo.repo}:`, error.message);
        return null;
    }
};

// Main generation function
const generateRegistry = async () => {
    console.log("Starting registry generation...");

    // 1. Fetch main library index
    console.log("Fetching Arduino library index...");
    const indexResponse = await fetch(LIBRARY_INDEX_URL);
    if (!indexResponse.ok) {
        throw new Error("Failed to fetch Arduino library index.");
    }
    const indexData = await indexResponse.json();
    const rawLibraries = indexData.libraries;
    console.log(`Found ${rawLibraries.length} raw library entries.`);

    // 2. Group libraries by name
    console.log("Grouping libraries by name...");
    const librariesMap = new Map();
    for (const lib of rawLibraries) {
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
                _repoInfo: repoInfo, // Temporary info for fetching
                versions: [versionInfo],
            });
        } else {
            librariesMap.get(lib.name).versions.push(versionInfo);
        }
    }
    let uniqueLibraries = Array.from(librariesMap.values());
    console.log(`Grouped into ${uniqueLibraries.length} unique libraries.`);

    // 3. Enrich unique libraries with GitHub data
    console.log("Enriching libraries with GitHub data...");
    const enrichedLibraries = [];
    let processedCount = 0;
    for (const lib of uniqueLibraries) {
        processedCount++;
        if (lib._repoInfo) {
            const githubData = await fetchGitHubData(lib._repoInfo);
            if (githubData) {
                // Add GitHub data to the library object
                lib.stars = githubData.stars;
                lib.isArchived = githubData.isArchived;
                lib.pushedAt = githubData.pushedAt;
                lib.openIssues = githubData.openIssues;
                lib.githubDescription = githubData.description;
                lib.license = githubData.license;
                lib.topics = githubData.topics;
            }
        }
        delete lib._repoInfo; // Clean up temporary field
        enrichedLibraries.push(lib);

        console.log(`Processed ${processedCount}/${uniqueLibraries.length} - ${lib.name}`);
        await new Promise(resolve => setTimeout(resolve, 500)); // Respect rate limits
    }
    
    // 4. Filter and sort the final list
    console.log("Filtering and sorting the final registry...");
    const finalRegistry = enrichedLibraries
        .filter(lib => lib.repository && !lib.isArchived) // Ensure it has a repo and is not archived
        .sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name)); // Sort by stars, then name
    
    console.log(`Final registry contains ${finalRegistry.length} active libraries.`);

    // 5. Save to file
    const output = {
        generatedAt: new Date().toISOString(),
        libraries: finalRegistry,
    };

    await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2));
    console.log(`Successfully wrote registry to ${OUTPUT_FILE}`);
};

// --- Run the script ---
generateRegistry().catch(error => {
    console.error("FATAL: Registry generation failed.", error);
    process.exit(1);
});
