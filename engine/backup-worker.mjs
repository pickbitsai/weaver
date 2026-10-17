// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits Weaver.
import { runBackupWorker } from "./backup.mjs";

try { runBackupWorker(process.argv[2], { trigger: process.argv[3] || "decision" }); }
catch { /* Background backups must stay silent and never interrupt the author. */ }
