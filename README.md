# NetX

A beautiful, single-file desktop application that shares internet access between two machines using only a **shared folder** (network drive, USB sync, Syncthing, etc.).

No complex networking setup. The built-in **Portable Browser** handles HTTP and HTTPS traffic seamlessly right out of the box.

## Features
- **One unified App**: Toggle between Server and Client modes instantly.
- **Launch Real Browser**: The Offline Client can automatically launch an isolated **Google Chrome** instance. No need to install dangerous Root CAs into your operating system, and no need to configure your system-wide proxy settings. Just click "Launch Chrome" and get a full browser.
- **Full HTTPS Support**: Built-in TLS MITM proxy completely handles HTTPS.
- **Cross-Platform**: Runs on Windows, macOS, and Linux.

---

## How It Works

```
Machine A (internet)          Shared Folder          Machine B (no internet)
┌──────────────────┐         ┌──────────┐           ┌────────────────────────┐
│  NetX Desktop    │◄────────│ req_.json│◄──────────│   NetX Desktop         │
│  [Server Mode]   │────────►│ res_.json│──────────►│   [Client Mode]        │
└──────────────────┘         └──────────┘           └──────────▲─────────────┘
                                                               │  (Proxy :8080)
                                                    ┌──────────┴─────────────┐
                                                    │ Real Google Chrome     │
                                                    └────────────────────────┘
```
The **Client** stands up a local HTTP/HTTPS proxy. It writes requests as JSON files to the shared folder. The **Server** reads them, fetches the URL from the real internet, and writes the response back. 

When you click "Launch Chrome" on the offline machine, NetX spawns an isolated Chrome window specifically configured to use this proxy and automatically trust the fake HTTPS certificates.

---

## Installation 

### Option 1 (Compile from Source)
Make sure NodeJS is installed.
```bash
git clone https://github.com/nos486/netx.git
cd netx
npm install
npm start         # Run app locally
```

### Option 2 (Build Executables)
NetX uses Electron Forge to compile standalone apps for any operating system.

**Mac / Linux / Windows**
Simply run the `make` command from the OS you want to target:
```bash
npm run make
```
The compiled Application (e.g., `<app>.dmg`, `<app>.exe`, `<app>.zip`, `<app>.deb`) will be generated inside the `/out/make/` folder. Copy that file onto a USB and put it on your offline machine.

*Note: You must run `npm run make` on a Windows machine to build the `.exe`, and on a Mac to build the `.dmg` / `.app` or `.zip`.*

---

## Usage Guide

### 1. Set up a Shared Folder
Both machines must be able to write to the same folder. Options:
- **Windows network share / SMB**
- **Syncthing** (recommended for near-instant speed)
- **USB drive** mounted on both machines.

### 2. Start the Server (The machine with Internet)
1. Open NetX.
2. Click **Server (Internet)** mode.
3. Click **Browse** and select your shared folder.
4. Click **Start Proxy**.
   *(It will display a live log of websites being fetched)*

### 3. Start the Client (The Offline machine)
1. Open NetX.
2. Click **Client (Offline)** mode.
3. Select the **SAME** shared folder.
4. Click **Start Proxy**.

**That's it!** The app will immediately switch to a Browser Launch view. 
Click **"Launch Chrome"**. A new Google Chrome window will open. Type any URL (like `https://github.com` or `https://google.com`) into the address bar and hit Enter. The page will load perfectly with no blocking certificate warnings!
