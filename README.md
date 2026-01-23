# CodeStudio Arduino Library Registry Generator

This repository contains a standalone script that generates an enriched, high-quality registry of Arduino libraries. It fetches data from the official Arduino library index, enriches it with metadata from the GitHub API (stars, archive status), and produces a clean, sorted `registry.json` file.

This process is designed to be run automatically via GitHub Actions, creating a pre-computed and optimized data source for other services.

## How It Works

1.  **Fetch:** The script downloads the latest official `library_index.json`.
2.  **Enrich:** For each library, it extracts the GitHub repository URL and calls the GitHub API to get:
    -   The number of stars (`stargazers_count`).
    -   The repository's archive status (`archived`).
3.  **Filter & Sort:**
    -   All **archived** repositories are **removed** from the list.
    -   The remaining active libraries are **sorted by the number of stars** in descending order.
4.  **Generate:** The final, clean list is saved as a single `registry.json` file.

---

## 🚀 Deployment and Setup Guide

Follow these steps to deploy this generator and get a public URL for your `registry.json`.

### Step 1: Create a New GitHub Repository

1.  Create a new **public** repository on GitHub. A public repository is recommended to take advantage of the unlimited free minutes for GitHub Actions.
    -   Suggested name: `codestudio-library-registry` or `arduino-library-database`.
2.  Clone the empty repository to your local machine.

### Step 2: Add Project Files

1.  Copy all the files from this project (`generate.js`, `package.json`, `.github/` folder, etc.) into your new repository.
2.  Commit and push the files to your new repository.

### Step 3: Create a GitHub Personal Access Token

The script needs a GitHub token to make API requests without hitting low rate limits.

1.  Go to your GitHub **Settings** > **Developer settings** > **Personal access tokens** > **Tokens (classic)**.
2.  Click **Generate new token**.
3.  Give it a descriptive name (e.g., `REGISTRY_GENERATOR_TOKEN`).
4.  Set an **Expiration** date (e.g., 90 days).
5.  Under **Select scopes**, check **only one** box: `public_repo` (under the `repo` section). This is the minimum permission required.
6.  Click **Generate token**.
7.  **Immediately copy the generated token.** You will not be able to see it again.

### Step 4: Add the Token to Repository Secrets

1.  In your **new GitHub repository**, go to `Settings` > `Secrets and variables` > `Actions`.
2.  Click the **New repository secret** button.
3.  For the **Name**, enter exactly `GH_TOKEN`.
4.  For the **Secret**, paste the token you copied in the previous step.
5.  Click **Add secret**.

### Step 5: Run the Workflow and Get Your URL

1.  Go to the **Actions** tab in your repository.
2.  In the left sidebar, click on the "Generate Arduino Library Registry" workflow.
3.  You will see a message saying "This workflow has a `workflow_dispatch` event trigger." Click the **Run workflow** button on the right.
4.  Keep the default branch selected and click **Run workflow**.

The process will now start. It will take **2-4 hours** to complete its first run. You can monitor its progress in the Actions tab.

Once the workflow finishes successfully, it will automatically commit the `registry.json` file to your repository.

### Step 6: Get the Public URL for `registry.json`

To get a permanent, raw URL for your generated file, you can use a service like `jsDelivr` or `raw.githack.com`. These are CDNs that serve raw files from GitHub repositories.

**Using jsDelivr (Recommended):**

The URL format is:
`https://cdn.jsdelivr.net/gh/YOUR_USERNAME/YOUR_REPO_NAME@latest/registry.json`

**Example:**
If your repository is `my-org/codestudio-library-registry`, the URL will be:
`https://cdn.jsdelivr.net/gh/my-org/codestudio-library-registry@latest/registry.json`

This URL will always point to the latest version of `registry.json` in your default branch. Use this URL in your other services (like the `library-registry` microservice) to fetch the pre-computed data.

---

## Manual Execution (for testing)

1.  **Install dependencies:** `npm install`
2.  **Set environment variable:** `export GITHUB_TOKEN="your_token"`
3.  **Run the script:** `node generate.js`
