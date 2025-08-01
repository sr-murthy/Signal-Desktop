// Copyright 2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { getEnvironment, Environment } from '../environment';
import { createLogger } from '../logging/log';

const log = createLogger('deprecated');

export function deprecated(message?: string): void {
  if (getEnvironment() !== Environment.PackagedApp) {
    log.error(`This method is deprecated: ${message}`);
  }
}
