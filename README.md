# Seclai Demos

A collection of interactive demos showcasing [Seclai](https://seclai.com) in action. Each subfolder is a self-contained project — clone the repo, `cd` into a demo, and follow its local instructions to run it.

## Purpose

These demos exist to make Seclai's governance, policy enforcement, and agent evaluation tangible. Rather than reading about guardrails, you can interact with real (or stubbed) agents and see how policies shape their behavior.

## Running a Demo

Each demo has its own `package.json` and README. The general pattern is:

```bash
git clone <this-repo>
cd demos/<demo-name>      # e.g. jailbreak-arcade
npm install
cp .env.example .env      # if present
npm run dev
```

## License

[MIT](LICENSE) © Seclai, Inc.
