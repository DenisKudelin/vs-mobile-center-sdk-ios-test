import * as FS from "fs";
import { VCSRepository } from "./VCSRepository/VCSRepository";
import { runXcodeSDKIntegration, MobileCenterSDKModule } from "./SDKIntegration/XcodeSDKIntegrationSteps";

const errors: string[] = [];

const projectPath = getParameterValue("-p");// || "D:\\Projects\\mobile-center-sdk-test.git";
if (!projectPath) {
    errors.push('Please specify the path to the iOS project.');
}

const appSecret = getParameterValue("-s");// || "myAppSecret";
if (!appSecret) {
    errors.push('Please specify your App Secret key.');
}

let sdkModules: MobileCenterSDKModule;//= MobileCenterSDKModule.Analytics | MobileCenterSDKModule.Crashes | MobileCenterSDKModule.Distribute;
sdkModules |= getParameterIfDefined("--analytics", MobileCenterSDKModule.Analytics);
sdkModules |= getParameterIfDefined("--crashes", MobileCenterSDKModule.Crashes);
sdkModules |= getParameterIfDefined("--distribute", MobileCenterSDKModule.Distribute);

function getParameterValue(name: string): string {
    const index = process.argv.indexOf(name);
    return (~index) ? process.argv[index + 1] : null;
}

function getParameterIfDefined(name: string, value: number): number {
    return (~process.argv.indexOf(name)) ? value : 0;
}

if (!errors.length) {
    runXcodeSDKIntegration(projectPath, appSecret, sdkModules).catch(x => console.error(x));
} else {
    errors.forEach(x => console.error(x));
}
