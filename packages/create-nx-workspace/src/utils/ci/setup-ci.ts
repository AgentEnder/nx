import * as ora from 'ora';
import { join } from 'path';

import { execAndWait } from '../child-process-utils';
import { mapErrorToBodyLines } from '../error-utils';
import { output } from '../output';
import { getPackageManagerCommand, PackageManager } from '../package-manager';
import { getFileName } from '../string-utils';

export async function setupCI(
  name: string,
  ci: string,
  packageManager: PackageManager,
  nxCloudSuccessfullyInstalled: boolean
) {
  if (!nxCloudSuccessfullyInstalled) {
    output.error({
      title: `CI workflow generation skipped`,
      bodyLines: [
        `Nx Cloud was not installed`,
        `The autogenerated CI workflow requires Nx Cloud to be set-up.`,
      ],
    });
  }
  const ciSpinner = ora(`Generating CI workflow`).start();
  try {
    const pmc = getPackageManagerCommand(packageManager);
    const res = await execAndWait(
      `${pmc.exec} nx g @nrwl/workspace:ci-workflow --ci=${ci}`,
      join(process.cwd(), getFileName(name))
    );
    ciSpinner.succeed('CI workflow has been generated successfully');
    return res;
  } catch (e) {
    ciSpinner.fail();
    if (e instanceof Error) {
      output.error({
        title: `Nx failed to generate CI workflow`,
        bodyLines: mapErrorToBodyLines(e),
      });
    } else {
      console.error(e);
    }

    process.exit(1);
  } finally {
    ciSpinner.stop();
  }
}
