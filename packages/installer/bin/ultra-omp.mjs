#!/usr/bin/env node
import { isCancel, multiselect, select } from '@clack/prompts';
import { main } from '../src/installer.mjs';

process.exitCode = await main({ prompts: { isCancel, multiselect, select } });
