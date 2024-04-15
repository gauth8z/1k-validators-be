import { Octokit } from "@octokit/rest";
import semver from "semver";

import { logger, queries } from "./index";

type TaggedRelease = {
  name: string;
  publishedAt: number;
};

export default class Monitor {
  public grace: number;
  public latestTaggedRelease: TaggedRelease | null = null;

  private ghApi: any;

  constructor(grace: number) {
    this.grace = grace;
    this.ghApi = new Octokit();
  }

  public async getLatestTaggedRelease(): Promise<TaggedRelease | null> {
    logger.info("(Monitor::getLatestTaggedRelease) Fetching latest release");
    let latestRelease;

    try {
      const { data: releases } = await this.ghApi.rest.repos.listReleases({
        owner: "paritytech",
        repo: "polkadot-sdk",
      });

      // Filter releases based on tag name
      const filteredReleases = releases.filter((release) => {
        // Check if the tag name matches the pattern 'polkadot-v*.*.*' (this is the polkadot client node version, as opposed to any kind of parachain node)
        return release.tag_name.startsWith("polkadot-v");
      });

      // Sort filtered releases based on their version number
      filteredReleases.sort((a, b) => {
        // Extract version numbers from tag names
        const versionA = a.tag_name.split("polkadot-v")[1];
        const versionB = b.tag_name.split("polkadot-v")[1];

        // Compare version numbers
        return this.compareVersions(versionA, versionB);
      });

      // Get the last release
      latestRelease = filteredReleases[filteredReleases.length - 1];
    } catch (e) {
      logger.info(JSON.stringify(e));
      logger.info(
        "{Monitor::getLatestTaggedRelease} Could not get latest release.",
      );
    }

    if (!latestRelease) return null;
    const { tag_name, published_at } = latestRelease;
    const publishedAt = new Date(published_at).getTime();

    // Extract version number from the tag name
    const versionMatch = tag_name.match(/v?(\d+\.\d+\.\d+)/);
    if (!versionMatch) {
      logger.warn(`Unable to extract version from tag name: ${tag_name}`);
      return null;
    }
    const version = versionMatch[1];

    await queries.setRelease(version, publishedAt);

    if (
      this.latestTaggedRelease &&
      version === this.latestTaggedRelease!.name
    ) {
      logger.info("(Monitor::getLatestTaggedRelease) No new release found");
      return null;
    }

    this.latestTaggedRelease = {
      name: version,
      publishedAt,
    };

    logger.info(
      `(Monitor::getLatestTaggedRelease) Latest release updated: ${version} | Published at: ${publishedAt}`,
    );

    return this.latestTaggedRelease;
  }

  // Function to compare version numbers
  public compareVersions(versionA, versionB) {
    const partsA = versionA.split(".").map((part) => parseInt(part, 10));
    const partsB = versionB.split(".").map((part) => parseInt(part, 10));

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const partA = partsA[i] || 0;
      const partB = partsB[i] || 0;

      if (partA < partB) {
        return -1;
      } else if (partA > partB) {
        return 1;
      }
    }

    return 0; // Versions are equal
  }

  /// Ensures that nodes have upgraded within a `grace` period.
  public async ensureUpgrades(): Promise<void> {
    // If there is no tagged release stored in state, fetch it now.
    if (!this.latestTaggedRelease) {
      await this.getLatestTaggedRelease();
    }

    const now = new Date().getTime();
    const nodes = await queries.allCandidates();

    for (const node of nodes) {
      const { name, version, updated } = node;

      const nodeVersion = semver.coerce(version);
      const latestVersion = semver.clean(
        this.latestTaggedRelease?.name?.split(`-`)[0] || "",
      );
      if (latestVersion && nodeVersion) {
        logger.debug(
          `(Monitor::ensureUpgrades) ${name} | version: ${nodeVersion} latest: ${latestVersion}`,
        );

        if (!nodeVersion) {
          if (updated) {
            await queries.reportNotUpdated(name);
          }
          continue;
        }

        const isUpgraded = semver.gte(nodeVersion, latestVersion);

        if (isUpgraded) {
          if (!updated) {
            await queries.reportUpdated(name);
          }
          continue;
        }

        const published = this.latestTaggedRelease?.publishedAt || 0;
        if (now < published + this.grace) {
          // Still in grace, but check if the node is only one patch version away.
          const incremented = semver.inc(nodeVersion, "patch") || "";
          if (semver.gte(incremented, latestVersion)) {
            await queries.reportUpdated(name);
            continue;
          }
        }

        await queries.reportNotUpdated(name);
      }
    }
  }
}
