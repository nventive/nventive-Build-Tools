import * as vsts from 'azure-devops-node-api';
import * as interfaces from 'azure-devops-node-api/interfaces/common/VSSInterfaces';
import * as tl from 'azure-pipelines-task-lib/task';
import { IRequestOptions } from 'azure-devops-node-api/interfaces/common/VsoBaseInterfaces';

import * as provenance from "./provenance";

export enum ProtocolType {
    NuGet,
    Maven,
    Npm,
    PyPi
}

export enum RegistryType {
    npm,
    NuGetV2,
    NuGetV3,
    PyPiSimple,
    PyPiUpload
}

export interface PackagingLocation {
    PackagingUris: string[];
    DefaultPackagingUri: string;
}

// Getting service urls from resource areas api
export async function getServiceUriFromAreaId(serviceUri: string, accessToken: string, areaId: string): Promise<string> {
    const serverType = tl.getVariable('System.ServerType');
    if (!serverType || serverType.toLowerCase() !== 'hosted') {
        return serviceUri;
    }

    const webApi = getWebApiWithProxy(serviceUri, accessToken);
    const locationApi = await webApi.getLocationsApi();

    tl.debug(`Getting URI for area ID ${areaId} from ${serviceUri}`);
    try {
        const serviceUriFromArea = await locationApi.getResourceArea(areaId);
        return serviceUriFromArea.locationUrl;
    } catch (error) {
        throw new Error(error);
    }
}

export async function getNuGetUriFromBaseServiceUri(serviceUri: string, accesstoken: string): Promise<string> {
    const nugetAreaId = 'B3BE7473-68EA-4A81-BFC7-9530BAAA19AD';

    return getServiceUriFromAreaId(serviceUri, accesstoken, nugetAreaId);
}

// Feeds url from location service
export async function getFeedUriFromBaseServiceUri(serviceUri: string, accesstoken: string): Promise<string> {
    const feedAreaId = '7ab4e64e-c4d8-4f50-ae73-5ef2e21642a5';

    return getServiceUriFromAreaId(serviceUri, accesstoken, feedAreaId);
}

export async function getBlobstoreUriFromBaseServiceUri(serviceUri: string, accesstoken: string): Promise<string> {
    const blobAreaId = '5294ef93-12a1-4d13-8671-9d9d014072c8';

    return getServiceUriFromAreaId(serviceUri, accesstoken, blobAreaId);
}

/**
 * PackagingLocation.PackagingUris:
 *  The first URI will always be the TFS collection URI
 *  The second URI, if existent, will be Packaging's default access point
 *  The remaining URI's will be alternate Packaging's access points
 */
export async function getPackagingUris(protocolType: ProtocolType): Promise<PackagingLocation> {
    tl.debug('Getting Packaging service access points');
    const collectionUrl = tl.getVariable('System.TeamFoundationCollectionUri');

    const pkgLocation: PackagingLocation = {
        PackagingUris: [collectionUrl],
        DefaultPackagingUri: collectionUrl
    };

    const serverType = tl.getVariable('System.ServerType');
    if (!serverType || serverType.toLowerCase() !== 'hosted') {
        return pkgLocation;
    }

    const accessToken = getSystemAccessToken();
    const areaId = getAreaIdForProtocol(protocolType);

    const serviceUri = await getServiceUriFromAreaId(collectionUrl, accessToken, areaId);

    const webApi = getWebApiWithProxy(serviceUri);

    const locationApi = await webApi.getLocationsApi();

    tl.debug('Acquiring Packaging endpoints from ' + serviceUri);

    const connectionData = await Retry(async () => {
        tl.debug('Attempting to get connection data');
        return await locationApi.getConnectionData(interfaces.ConnectOptions.IncludeServices);
    }, 4, 100);

    tl.debug('Successfully acquired the connection data');
    const defaultAccessPoint: string = connectionData.locationServiceData.accessMappings.find((mapping) =>
        mapping.moniker === connectionData.locationServiceData.defaultAccessMappingMoniker
    ).accessPoint;

    pkgLocation.DefaultPackagingUri = defaultAccessPoint;
    pkgLocation.PackagingUris.push(defaultAccessPoint);
    pkgLocation.PackagingUris = pkgLocation.PackagingUris.concat(
        connectionData.locationServiceData.accessMappings.map((mapping) => {
            return mapping.accessPoint;
        }));

    tl.debug('Acquired location');
    tl.debug(JSON.stringify(pkgLocation));
    return pkgLocation;
}

export function getSystemAccessToken(): string {
    tl.debug('Getting credentials for local feeds');
    const auth = tl.getEndpointAuthorization('SYSTEMVSSCONNECTION', false);
    if (auth.scheme === 'OAuth') {
        tl.debug('Got auth token');
        return auth.parameters['AccessToken'];
    } else {
        tl.warning('Could not determine credentials to use');
    }
}

function getAreaIdForProtocol(protocolType: ProtocolType): string {
    switch (protocolType) {
        case ProtocolType.Maven:
            return '6F7F8C07-FF36-473C-BCF3-BD6CC9B6C066';
        case ProtocolType.Npm:
            return '4C83CFC1-F33A-477E-A789-29D38FFCA52E';
        default:
        case ProtocolType.NuGet:
            return 'B3BE7473-68EA-4A81-BFC7-9530BAAA19AD';
    }
}

export function getWebApiWithProxy(serviceUri: string, accessToken?: string): vsts.WebApi {
    if (!accessToken) {
        accessToken = getSystemAccessToken();
    }

    const credentialHandler = vsts.getBasicHandler('vsts', accessToken);
    const options: IRequestOptions = {
        proxy: tl.getHttpProxyConfiguration(serviceUri)
    };
    return new vsts.WebApi(serviceUri, credentialHandler, options);
}

interface RegistryLocation {
    apiVersion: string,
    area: string,
    locationId: string
};

export async function getFeedRegistryUrl(
    packagingUrl: string, 
    registryType: RegistryType, 
    feedId: string,
    accessToken?: string,
    useSession?: boolean): Promise<string> {
    let loc : RegistryLocation;
    switch (registryType) {
        case RegistryType.npm:
            loc = {
                apiVersion: '3.0-preview.1',
                area: 'npm',
                locationId: 'D9B75B07-F1D9-4A67-AAA6-A4D9E66B3352'
            };
            break;
        case RegistryType.NuGetV2:
            loc = {
                apiVersion: '3.0-preview.1',
                area: 'nuget',
                locationId: "5D6FC3B3-EF78-4342-9B6E-B3799C866CFA"
            };
            break;
        case RegistryType.PyPiSimple:
            loc = {
                apiVersion: '5.0',
                area: 'pypi',
                locationId: "93377A2C-F5FB-48B9-A8DC-7781441CABF1"
            };
            break;        
        case RegistryType.PyPiUpload:
            loc = {
                apiVersion: '5.0',
                area: 'pypi',
                locationId: "C7A75C1B-08AC-4B11-B468-6C7EF835C85E"
            };
            break;
        default:
        case RegistryType.NuGetV3:
            loc = {
                apiVersion: '3.0-preview.1',
                area: 'nuget',
                locationId: "9D3A4E8E-2F8F-4AE1-ABC2-B461A51CB3B3"
            };
            break;
    }

    tl.debug("Getting registry url from " + packagingUrl);

    const vssConnection = getWebApiWithProxy(packagingUrl, accessToken);

    let sessionId = feedId;
    if (useSession) {
        sessionId = await provenance.ProvenanceHelper.GetSessionId(
            feedId,
            loc.area /* protocol */,
            vssConnection.serverUrl,
            [vssConnection.authHandler],
            vssConnection.options);
    }

    const data = await Retry(async () => {
        return await vssConnection.vsoClient.getVersioningData(loc.apiVersion, loc.area, loc.locationId, { feedId: sessionId });
    }, 4, 100);

    tl.debug("Feed registry url: " + data.requestUrl);
    return data.requestUrl;
}

// This should be replaced when retry is implemented in vso client.
async function Retry<T>(cb : () => Promise<T>, max_retry: number, retry_delay: number) : Promise<T> {
    try {
        return await cb();
    } catch(exception) {
        tl.debug(JSON.stringify(exception));
        if(max_retry > 0)
        {
            tl.debug("Waiting " + retry_delay + "ms...");
            await delay(retry_delay);
            tl.debug("Retrying...");
            return await Retry<T>(cb, max_retry-1, retry_delay*2);
        } else {
            throw new Error(exception);
        }
    }
}
function delay(delayMs:number) {
    return new Promise(function(resolve) { 
        setTimeout(resolve, delayMs);
    });
 }