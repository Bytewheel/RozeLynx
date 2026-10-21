#!/usr/bin/env python3
"""RozeLynx Extension Assembler

Builds the RozeLynx Features extension from individual modules.
Each USE flag controls whether a module is included.

Usage:
  python3 assemble-extension.py [--enable feature1,feature2,...] --output-dir DIR
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

AVAILABLE_FEATURES = {
    'chrome-web-store': {
        'module': 'chrome-web-store',
        'description': 'Chrome Web Store extension installation',
        'files': ['background.js', 'content.js', 'converter.html', 'converter.js',
                  'lib/jszip.min.js', 'lib/convert.js'],
        'background_script': 'modules/chrome-web-store/background.js',
        'host_permissions': [
            '*://chrome.google.com/*',
            '*://chromewebstore.google.com/*',
            '*://clients2.google.com/*',
        ],
        'content_scripts': [{
            'matches': [
                '*://chrome.google.com/*',
                '*://chromewebstore.google.com/*',
            ],
            'js': ['modules/chrome-web-store/content.js'],
            'run_at': 'document_end',
        }],
        'web_accessible_resources': [{
            'resources': [
                'modules/chrome-web-store/converter.html',
                'modules/chrome-web-store/converter.js',
            ],
            'matches': [
                '*://chrome.google.com/*',
                '*://chromewebstore.google.com/*',
            ],
        }],
    },
    'experiments': {
        'module': 'experiments',
        'description': 'A/B testing and feature flag system',
        'files': ['background.js'],
        'background_script': 'modules/experiments/background.js',
    },
    'external-browser': {
        'module': 'external-browser',
        'description': 'Open links in external browsers',
        'files': ['background.js'],
        'background_script': 'modules/external-browser/background.js',
        'permissions': ['menus', 'contextMenus'],
    },
    'external-link': {
        'module': 'external-link',
        'description': 'Profile & network-interface chooser for external link clicks',
        'files': ['background.js', 'choose.html', 'choose.js', 'choose.css'],
        'background_script': 'modules/external-link/background.js',
    },
    'i18n': {
        'module': 'i18n',
        'description': 'Internationalization utilities',
        'files': ['background.js'],
        'background_script': 'modules/i18n/background.js',
        'permissions': ['management'],
    },
    'mouse-gestures': {
        'module': 'mouse-gestures',
        'description': 'Mouse gesture navigation',
        'files': ['background.js', 'content.js', 'bookmark.html', 'bookmark.js',
                  'shot.html', 'shot.js', 'devtools-bridge.html', 'devtools-bridge.js',
                  'browsers.html', 'browsers.js'],
        'background_script': 'modules/mouse-gestures/background.js',
        'permissions': ['sessions', 'bookmarks', 'nativeMessaging'],
        'host_permissions': ['<all_urls>'],
        'content_scripts': [{
            'matches': ['*://*/*'],
            'js': ['modules/mouse-gestures/content.js'],
            'run_at': 'document_start',
            'all_frames': True,
        }],
        'web_accessible_resources': [{
            'resources': [
                'modules/mouse-gestures/bookmark.html',
                'modules/mouse-gestures/bookmark.js',
                'modules/mouse-gestures/shot.html',
                'modules/mouse-gestures/shot.js',
                'modules/mouse-gestures/devtools-bridge.html',
                'modules/mouse-gestures/devtools-bridge.js',
                'modules/mouse-gestures/browsers.html',
                'modules/mouse-gestures/browsers.js',
            ],
            'matches': ['*://*/*'],
        }],
    },
    'qr-code': {
        'module': 'qr-code',
        'description': 'QR code generator',
        'files': ['background.js', 'popup.html', 'popup.js', 'lib/qrcode.js'],
        'background_script': 'modules/qr-code/background.js',
        'permissions': ['clipboardWrite'],
        'action': {
            'default_popup': 'modules/qr-code/popup.html',
            'default_title': 'RozeLynx QR Code',
            'default_icon': {
                '16': 'icons/icon16.png',
                '32': 'icons/icon32.png',
                '48': 'icons/icon48.png',
            },
        },
    },
    'pwa': {
        'module': 'pwa',
        'description': 'Progressive Web App installation',
        'files': ['background.js', 'content.js'],
        'background_script': 'modules/pwa/background.js',
        'permissions': ['notifications'],
        'host_permissions': ['*://*/*'],
        'content_scripts': [{
            'matches': ['*://*/*'],
            'js': ['modules/pwa/content.js'],
            'run_at': 'document_idle',
        }],
    },
    'lepton-skin': {
        'module': 'lepton-skin',
        'description': 'Compact Lepton UI theme',
        'files': ['background.js', 'content.js', 'leptonContent.css'],
        'background_script': 'modules/lepton-skin/background.js',
        'permissions': ['theme'],
        'host_permissions': ['*://*/*'],
        'content_scripts': [{
            'matches': ['*://*/*'],
            'js': ['modules/lepton-skin/content.js'],
            'run_at': 'document_start',
            'all_frames': True,
        }],
        'web_accessible_resources': [{
            'resources': [
                'modules/lepton-skin/leptonContent.css',
            ],
            'matches': ['*://*/*'],
        }],
    },
    'ip-protection': {
        'module': 'ip-protection',
        'description': 'IP protection privacy overrides',
        'files': ['background.js'],
        'background_script': 'modules/ip-protection/background.js',
    },
    'net-iface': {
        'module': 'netiface',
        'description': 'Per-tab / per-container / per-URL / per-profile network-interface assignment',
        # urlrules-ui.js is rendered by the qr-code popup (the extension's only
        # popup), which loads it as ../netiface/urlrules-ui.js. It stays in this
        # module so the whole feature - service calls, editor, picker - can move
        # to its own popup without untangling qr-code. popup.html guards for its
        # absence: the section stays hidden when this file is not in the build.
        'files': ['background.js', 'popup.html', 'popup.js', 'urlrules-ui.js'],
        'background_script': 'modules/netiface/background.js',
        'permissions': ['contextMenus', 'storage', 'tabs'],
    },
    'user-agent': {
        'module': 'user-agent',
        'description': 'User agent switcher: preset/raw global override and per-URL rules',
        # presets.js is loaded on demand by ua-ui.js (popup) and by the
        # options page, because a static <script> tag in either would 404 on a
        # build whose XPI does not carry this module.
        'files': ['background.js', 'content.js', 'presets.js', 'ua-ui.js'],
        'background_script': 'modules/user-agent/background.js',
        # webRequest + webRequestBlocking already live in the base manifest
        # (the header rewrite is the point of the module).
        'permissions': [],
        'content_scripts': [{
            'matches': ['*://*/*'],
            'js': ['modules/user-agent/content.js'],
            'run_at': 'document_start',
            'all_frames': True,
        }],
    },
    'sync': {
        'module': 'sync',
        'description': 'Account-less state sync via an encrypted magic link',
        # sync-ui.js is loaded into the qr-code popup by the sync button
        # itself, after the background answers 'sync:present'; a build
        # without this module shows a button that says it is not in this
        # build instead of a dead panel.
        'files': ['background.js', 'sync-ui.js'],
        'background_script': 'modules/sync/background.js',
        # history + cookies are the two permissions the base manifest does
        # not already hold: the link cannot recreate the browsing state it
        # claims to carry without them (tabs / management / storage /
        # alarms are already in the base manifest).
        'permissions': ['history', 'cookies'],
    },
    'handoff-relay': {
        'module': 'handoff-relay',
        'description': 'ext: handler delivery for the browser-side download hand-off',
        # The hand-off ENGINE is browser code (uriloader/exthandler/
        # rozelynx-handoff/, USE=download-handoff); this module only
        # forwards download messages to other extensions and keeps the
        # installed-extensions probe pref current. Ships with the same USE
        # flag as the engine so the two halves never drift apart.
        'files': ['background.js'],
        'background_script': 'modules/handoff-relay/background.js',
        'permissions': [],
    },
}


def load_base_manifest(extension_dir):
    manifest_path = os.path.join(extension_dir, 'manifest.json')
    with open(manifest_path, 'r') as f:
        return json.load(f)


def build_manifest(base_manifest, enabled_features, extension_dir):
    manifest = dict(base_manifest)

    manifest['background'] = {
        'scripts': ['lib/feature-loader.js', 'background.js'],
    }

    content_scripts = []
    for feature_id in enabled_features:
        feature = AVAILABLE_FEATURES.get(feature_id)
        if not feature:
            continue

        if 'content_scripts' in feature:
            content_scripts.extend(feature['content_scripts'])

        if 'permissions' in feature:
            for perm in feature['permissions']:
                if perm not in manifest.get('permissions', []):
                    manifest.setdefault('permissions', []).append(perm)

        if 'host_permissions' in feature:
            for host in feature['host_permissions']:
                if host not in manifest.get('host_permissions', []):
                    manifest.setdefault('host_permissions', []).append(host)

        if 'action' in feature:
            manifest['action'] = feature['action']

        if 'web_accessible_resources' in feature:
            manifest.setdefault('web_accessible_resources', [])
            manifest['web_accessible_resources'].extend(feature['web_accessible_resources'])

    if content_scripts:
        manifest['content_scripts'] = content_scripts

    return manifest


def patch_feature_loader(extension_dir, enabled_features):
    loader_path = os.path.join(extension_dir, 'lib', 'feature-loader.js')
    with open(loader_path, 'r') as f:
        content = f.read()

    for feature_id in AVAILABLE_FEATURES:
        feature = AVAILABLE_FEATURES[feature_id]
        disabled_line = f'//ROZELYNX_FEATURE_DISABLED: "{feature_id}":'

        if feature_id in enabled_features:
            content = content.replace(disabled_line, f'"{feature_id}":')

    with open(loader_path, 'w') as f:
        f.write(content)


def assemble_extension(extension_dir, output_dir, enabled_features):
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    src_ext = Path(extension_dir)
    dest_dir = Path(output_dir)

    shutil.copytree(src_ext / 'lib', dest_dir / 'lib', dirs_exist_ok=True)
    shutil.copy2(src_ext / 'manifest.json', dest_dir / 'manifest.json')
    shutil.copy2(src_ext / 'background.js', dest_dir / 'background.js')
    shutil.copytree(src_ext / 'options', dest_dir / 'options', dirs_exist_ok=True)
    if (src_ext / 'icons').is_dir():
        shutil.copytree(src_ext / 'icons', dest_dir / 'icons', dirs_exist_ok=True)

    modules_dir = dest_dir / 'modules'
    modules_dir.mkdir(parents=True, exist_ok=True)

    for feature_id in enabled_features:
        feature = AVAILABLE_FEATURES.get(feature_id)
        if not feature:
            print(f"  Warning: Unknown feature '{feature_id}', skipping")
            continue

        src_module = src_ext / 'modules' / feature['module']
        dest_module = modules_dir / feature['module']

        if src_module.exists():
            if dest_module.exists():
                shutil.rmtree(dest_module)
            shutil.copytree(src_module, dest_module)
            print(f"  + {feature_id}: {feature['description']}")
        else:
            print(f"  Warning: Module dir not found: {src_module}")

    patch_feature_loader(str(dest_dir), enabled_features)

    base_manifest = load_base_manifest(str(dest_dir))
    final_manifest = build_manifest(base_manifest, enabled_features, str(dest_dir))

    with open(dest_dir / 'manifest.json', 'w') as f:
        json.dump(final_manifest, f, indent=2)

    print(f"\nExtension assembled in: {output_dir}")
    print(f"Enabled features ({len(enabled_features)}): {', '.join(enabled_features)}")


def main():
    parser = argparse.ArgumentParser(description='RozeLynx Extension Assembler')
    parser.add_argument('--extension-dir', required=True,
                        help='Path to extension source directory')
    parser.add_argument('--output-dir', required=True,
                        help='Output directory for assembled extension')
    parser.add_argument('--enable', default='',
                        help='Comma-separated list of features to enable')
    parser.add_argument('--list', action='store_true',
                        help='List all available features')
    parser.add_argument('--disable', default='',
                        help='Comma-separated list of features to disable (disable from all)')

    args = parser.parse_args()

    if args.list:
        print("Available features:")
        for fid, feature in sorted(AVAILABLE_FEATURES.items()):
            print(f"  {fid:20s} - {feature['description']}")
        return 0

    if args.disable:
        disabled = set(f.strip() for f in args.disable.split(',') if f.strip())
        enabled = [f for f in AVAILABLE_FEATURES if f not in disabled]
    elif args.enable:
        enabled = [f.strip() for f in args.enable.split(',') if f.strip()]
    else:
        enabled = list(AVAILABLE_FEATURES.keys())

    valid_enabled = [f for f in enabled if f in AVAILABLE_FEATURES]
    invalid = [f for f in enabled if f not in AVAILABLE_FEATURES]

    if invalid:
        print(f"Warning: Unknown features ignored: {', '.join(invalid)}")

    if not valid_enabled:
        print("Error: No valid features enabled")
        return 1

    assemble_extension(args.extension_dir, args.output_dir, valid_enabled)
    return 0


if __name__ == '__main__':
    sys.exit(main())
