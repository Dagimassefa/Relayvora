# Experimental completion gate

From a Git project with Kane installed and signed in, start the application and run:

```sh
relayvora gate run --spec task.md --objective "Open http://localhost:3000, save an item, and verify it remains after refresh"
relayvora gate status
```

The gate fingerprints HEAD, the index, tracked and non-ignored untracked file contents, and the specified acceptance file. It records a redacted Kane result in Relayvora's local data directory. A functional failure produces `recovery_required`; a changed source or specification produces `stale`; an incomplete result produces `blocked`. Subsequent runs retain the initial specification and objective as a baseline. Both commands currently return a nonzero exit code because verified completion is unavailable.

**A passing Kane run is also blocked.** The gate has no trusted method yet to prove that the browser reached an application built from the fingerprinted source. It therefore never reports `verified`. This is an experimental component, not an enforced end-to-end completion workflow. Regular checkpoints and handoffs do not use this gate.

The fingerprint excludes ignored files except for the explicitly named specification; external services, environment variables, dependencies and runtime state are not covered. The state file is local and writable by the same user or agent; the baseline is not tamper-resistant. There is no run lock yet. Do not use this gate as a security boundary or as proof of acceptance-test integrity. State reports are locally stored summaries, not original Kane evidence packs.

Changing the specification or objective requires a new, separately authorized task; task selection and baseline reset are not implemented yet. To protect the existing baseline, this prototype refuses to replace it automatically.
