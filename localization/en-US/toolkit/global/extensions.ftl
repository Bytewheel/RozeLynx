

webext-perms-header2 = Add { $extension }
webext-perms-list-intro-unsigned = This unverified extension might put your privacy at risk or compromise your device. Only add it if you trust the source.
webext-perms-sideload-header = { $extension } added
webext-perms-optional-perms-header2 = { $extension } requests additional permissions


webext-perms-header-required-perms = Required permissions:
webext-perms-header-optional-settings = Optional settings:

webext-perms-header-update-required-perms = New required permissions:

webext-perms-header-optional-required-perms = New permissions:

webext-perms-header-data-collection-perms = Required data collection:
webext-perms-header-data-collection-is-none = Data collection:

webext-perms-header-update-data-collection-perms = New required data collection:

webext-perms-header-optional-data-collection-perms = New data collection:


webext-perms-add =
    .label = Add
    .accesskey = A
webext-perms-cancel =
    .label = Cancel
    .accesskey = C

webext-perms-sideload-text = Another program on your computer installed an add-on that may affect your browser. Please review this add-on’s permissions requests and choose to Enable or Cancel (to leave it disabled).
webext-perms-sideload-text-no-perms = Another program on your computer installed an add-on that may affect your browser. Please choose to Enable or Cancel (to leave it disabled).
webext-perms-sideload-enable =
    .label = Enable
    .accesskey = E
webext-perms-sideload-cancel =
    .label = Cancel
    .accesskey = C

webext-perms-update-text2 = { $extension } has been updated. You must approve new permissions before the updated version will install. Choosing “Cancel” will maintain your current extension version.
webext-perms-update-accept =
    .label = Update
    .accesskey = U

webext-perms-optional-perms-list-intro = It wants to:
webext-perms-optional-perms-allow =
    .label = Allow
    .accesskey = A
webext-perms-optional-perms-deny =
    .label = Deny
    .accesskey = D

webext-perms-host-description-all-urls = Access your data for all websites

webext-perms-host-description-file-urls = Access local files on your computer

webext-perms-host-description-wildcard = Access your data for sites in the { $domain } domain

webext-perms-host-description-one-site = Access your data for { $domain }

webext-perms-host-description-one-domain = Access your data for sites in { $domain } domains

webext-perms-host-description-multiple-domains =
    { $domainCount ->
       *[other] Access your data for sites in { $domainCount } domains
    }


webext-perms-description-data-none = The developer says this extension doesn’t require data collection.

webext-perms-description-data-some = The developer says this extension collects: { $permissions }

webext-perms-description-data-some-update = The developer says the extension will collect: { $permissions }

webext-perms-description-data-some-optional = The developer says the extension wants to collect: { $permissions }

webext-perms-update-text-with-data-collection = { $extension } requires new settings to update

webext-perms-update-list-intro-with-data-collection = Cancel to keep your current version and settings, or update to get the new version and approve the changes.

webext-perms-optional-text-with-data-collection = { $extension } requests additional settings

webext-perms-optional-text-with-data-collection-only = { $extension } requests additional data collection


webext-site-perms-header-with-gated-perms-midi = This add-on gives { $hostname } access to your MIDI devices.
webext-site-perms-header-with-gated-perms-midi-sysex = This add-on gives { $hostname } access to your MIDI devices (with SysEx support).
webext-site-perms-header-with-gated-perms-serial = This add-on gives { $hostname } access to your serial devices.


webext-site-perms-description-gated-perms-midi =
    These are usually plug-in devices like audio synthesizers, but might also be built into your computer.

    Websites are normally not allowed to access MIDI devices. Improper usage could cause damage or compromise security.

webext-site-perms-description-gated-perms-webserial =
    These are devices like microcontrollers, 3D printers, and other devices that connect via USB, serial ports, or Bluetooth.

    You will be able to choose which devices the website can access.

    Websites are normally not allowed to access serial devices. Improper usage could cause damage or compromise security.


webext-site-perms-header-with-perms = Add { $extension }? This extension grants the following capabilities to { $hostname }:
webext-site-perms-header-unsigned-with-perms = Add { $extension }? This extension is unverified. Malicious extensions can steal your private information or compromise your computer. Only add it if you trust the source. This extension grants the following capabilities to { $hostname }:


webext-site-perms-midi = Access MIDI devices
webext-site-perms-midi-sysex = Access MIDI devices with SysEx support
webext-site-perms-serial = Access serial devices
