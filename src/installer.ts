// Load tempDirectory before it gets wiped by tool-cache
let tempDirectory = process.env['RUNNER_TEMPDIRECTORY'] || '';
import * as core from '@actions/core';
import * as io from '@actions/io';
import * as tc from '@actions/tool-cache';
import * as restm from 'typed-rest-client/RestClient';
import * as os from 'os';
import * as path from 'path';
import * as semver from 'semver';

let osPlat: string = os.platform();
let osArch: string = os.arch();

if (!tempDirectory) {
  let baseLocation;
  if (process.platform === 'win32') {
    // On windows use the USERPROFILE env variable
    baseLocation = process.env['USERPROFILE'] || 'C:\\';
  } else {
    if (process.platform === 'darwin') {
      baseLocation = '/Users';
    } else {
      baseLocation = '/home';
    }
  }
  tempDirectory = path.join(baseLocation, 'actions', 'temp');
}

//
// Node versions interface
// see https://nodejs.org/dist/index.json
//
interface INodeVersion {
  version: string;
  date: string;
  files: string[];
}

export async function getNode(versionSpec: string, mirror: string) {
  // check cache
  let toolPath: string;
  toolPath = tc.find('node', versionSpec);

  // If not found in cache, download
  if (!toolPath) {
    let version: string;
    const c = semver.clean(versionSpec) || '';
    // If explicit version
    if (semver.valid(c) != null) {
      // version to download
      version = versionSpec;
    } else {
      // query nodejs.org for a matching version
      version = await queryLatestMatch(versionSpec, mirror);
      if (!version) {
        throw new Error(
          `Unable to find Node version '${versionSpec}' for platform ${osPlat} and architecture ${osArch}.`
        );
      }

      // check cache
      toolPath = tc.find('node', version);
    }

    if (!toolPath) {
      // download, extract, cache
      toolPath = await acquireNode(version, mirror);
    }
  }

  //
  // a tool installer initimately knows details about the layout of that tool
  // for example, node binary is in the bin folder after the extract on Mac/Linux.
  // layouts could change by version, by platform etc... but that's the tool installers job
  //
  if (osPlat != 'win32') {
    toolPath = path.join(toolPath, 'bin');
  }

  //
  // prepend the tools path. instructs the agent to prepend for future tasks
  core.addPath(toolPath);
}

export async function queryLatestMatch(
  versionSpec: string,
  mirror: string
): Promise<string> {
  // node offers a json list of versions
  let dataFileName: string;
  switch (osPlat) {
    case 'linux':
      dataFileName = 'linux-' + osArch;
      break;
    case 'darwin':
      dataFileName = 'osx-' + osArch + '-tar';
      break;
    case 'win32':
      dataFileName = 'win-' + osArch + '-exe';
      break;
    default:
      throw new Error(`Unexpected OS '${osPlat}'`);
  }

  let versions: INodeVersion[] = [];
  let dataUrl = `${mirror}/index.json`;
  let rest: restm.RestClient = new restm.RestClient('setup-node');
  let nodeVersions: INodeVersion[] =
    (await rest.get<INodeVersion[]>(dataUrl)).result || [];
  nodeVersions.forEach((nodeVersion: INodeVersion) => {
    // ensure this version supports your os and platform
    if (nodeVersion.files.indexOf(dataFileName) >= 0) {
      versions.push(nodeVersion);
    }
  });

  // get the latest version that matches the version spec
  let version: string = evaluateVersions(versions, versionSpec);
  return version;
}

// TODO - should we just export this from @actions/tool-cache? Lifted directly from there
function evaluateVersions(
  versions: INodeVersion[],
  versionSpec: string
): string {
  let version = '';
  core.debug(`evaluating ${versions.length} versions`);
  versions = versions.sort((a, b) => {
    const versionA: semver.SemVer | null = semver.coerce(a.version);
    const versionB: semver.SemVer | null = semver.coerce(b.version);
    // If versions are equal, compare date instead
    if (versionA === versionB || versionA === null || versionB === null) {
      if (new Date(a.date) > new Date(b.date)) {
        return 1;
      }
      return -1;
    }
    if (semver.gt(versionA, versionB)) {
      return 1;
    }
    return -1;
  });
  for (let i = versions.length - 1; i >= 0; i--) {
    const potential: string = versions[i].version;
    const semverPotential: semver.SemVer | null = semver.coerce(potential);
    if (semverPotential === null) continue;
    const satisfied: boolean = semver.satisfies(semverPotential, versionSpec);
    if (satisfied) {
      version = potential;
      break;
    }
  }

  if (version) {
    core.debug(`matched: ${version}`);
  } else {
    core.debug('match not found');
  }

  return version;
}

async function acquireNode(version: string, mirror: string): Promise<string> {
  //
  // Download - a tool installer intimately knows how to get the tool (and construct urls)
  //
  version = semver.clean(version) || '';
  let fileName: string =
    osPlat == 'win32'
      ? 'node-v' + version + '-win-' + os.arch()
      : 'node-v' + version + '-' + osPlat + '-' + os.arch();
  let urlFileName: string =
    osPlat == 'win32' ? fileName + '.7z' : fileName + '.tar.gz';

  let downloadUrl = `${mirror}/v` + version + '/' + urlFileName;

  let downloadPath: string;

  try {
    downloadPath = await tc.downloadTool(downloadUrl);
  } catch (err) {
    if (err instanceof tc.HTTPError && err.httpStatusCode == 404) {
      return await acquireNodeFromFallbackLocation(version, mirror);
    }

    throw err;
  }

  //
  // Extract
  //
  let extPath: string;
  if (osPlat == 'win32') {
    let _7zPath = path.join(__dirname, '..', 'externals', '7zr.exe');
    extPath = await tc.extract7z(downloadPath, undefined, _7zPath);
  } else {
    extPath = await tc.extractTar(downloadPath);
  }

  //
  // Install into the local tool cache - node extracts with a root folder that matches the fileName downloaded
  //
  let toolRoot = path.join(extPath, fileName);
  return await tc.cacheDir(toolRoot, 'node', version);
}

// For non LTS versions of Node, the files we need (for Windows) are sometimes located
// in a different folder than they normally are for other versions.
// Normally the format is similar to: https://nodejs.org/dist/v5.10.1/node-v5.10.1-win-x64.7z
// In this case, there will be two files located at:
//      /dist/v5.10.1/win-x64/node.exe
//      /dist/v5.10.1/win-x64/node.lib
// If this is not the structure, there may also be two files located at:
//      /dist/v0.12.18/node.exe
//      /dist/v0.12.18/node.lib
// This method attempts to download and cache the resources from these alternative locations.
// Note also that the files are normally zipped but in this case they are just an exe
// and lib file in a folder, not zipped.
async function acquireNodeFromFallbackLocation(
  version: string,
  mirror: string
): Promise<string> {
  // Create temporary folder to download in to
  let tempDownloadFolder: string =
    'temp_' + Math.floor(Math.random() * 2000000000);
  let tempDir: string = path.join(tempDirectory, tempDownloadFolder);
  await io.mkdirP(tempDir);
  let exeUrl: string;
  let libUrl: string;
  try {
    exeUrl = `${mirror}/v${version}/win-${os.arch()}/node.exe`;
    libUrl = `${mirror}/v${version}/win-${os.arch()}/node.lib`;

    const exePath = await tc.downloadTool(exeUrl);
    await io.cp(exePath, path.join(tempDir, 'node.exe'));
    const libPath = await tc.downloadTool(libUrl);
    await io.cp(libPath, path.join(tempDir, 'node.lib'));
  } catch (err) {
    if (err instanceof tc.HTTPError && err.httpStatusCode == 404) {
      exeUrl = `${mirror}/v${version}/node.exe`;
      libUrl = `${mirror}/v${version}/node.lib`;

      const exePath = await tc.downloadTool(exeUrl);
      await io.cp(exePath, path.join(tempDir, 'node.exe'));
      const libPath = await tc.downloadTool(libUrl);
      await io.cp(libPath, path.join(tempDir, 'node.lib'));
    } else {
      throw err;
    }
  }
  return await tc.cacheDir(tempDir, 'node', version);
}
