
addons-page-title = Add-ons Manager

search-header =
    .placeholder = Search addons.mozilla.org
    .searchbuttonlabel = Search


list-empty-get-extensions-message =
    Get extensions and themes on <a data-l10n-name="get-extensions">{ $domain }</a>

list-empty-get-dictionaries-message =
    Get dictionaries on <a data-l10n-name="get-extensions">{ $domain }</a>

list-empty-get-language-packs-message =
    Get language packs on <a data-l10n-name="get-extensions">{ $domain }</a>


list-empty-installed =
    .value = You don’t have any add-ons of this type installed

list-empty-available-updates =
    .value = No updates found

list-empty-recent-updates =
    .value = You haven’t recently updated any add-ons

list-empty-find-updates =
    .label = Check For Updates

list-empty-button =
    .label = Learn more about add-ons

help-button = Add-ons Support
sidebar-help-button-title =
    .title = Add-ons Support

addons-settings-button = { -brand-short-name } Settings
sidebar-settings-button-title =
    .title = { -brand-short-name } Settings

show-unsigned-extensions-button =
    .label = Some extensions could not be verified

show-all-extensions-button =
    .label = Show all extensions

detail-version =
    .label = Version

detail-last-updated =
    .label = Last Updated

addon-detail-description-expand = Show more
addon-detail-description-collapse = Show less

detail-contributions-description = The developer of this add-on asks that you help support its continued development by making a small contribution.

detail-contributions-button = Contribute
    .title = Contribute to the development of this add-on
    .accesskey = C

detail-update-type =
    .value = Automatic Updates

detail-update-default =
    .label = Default
    .tooltiptext = Automatically install updates only if that’s the default

detail-update-automatic =
    .label = On
    .tooltiptext = Automatically install updates

detail-update-manual =
    .label = Off
    .tooltiptext = Don’t automatically install updates

detail-private-browsing-label = Run in Private Windows

detail-private-disallowed-label = Not Allowed in Private Windows
detail-private-disallowed-description2 = This extension does not run while private browsing. <a data-l10n-name="learn-more">Learn more</a>

detail-private-required-label = Requires Access to Private Windows
detail-private-required-description2 = This extension has access to your online activities while private browsing. <a data-l10n-name="learn-more">Learn more</a>

detail-private-browsing-on =
    .label = Allow
    .tooltiptext = Enable in Private Browsing

detail-private-browsing-off =
    .label = Don’t Allow
    .tooltiptext = Disable in Private Browsing

detail-home =
    .label = Homepage

detail-home-value =
    .value = { detail-home.label }

detail-repository =
    .label = Add-on Profile

detail-repository-value =
    .value = { detail-repository.label }

detail-check-for-updates =
    .label = Check for Updates
    .accesskey = U
    .tooltiptext = Check for updates for this add-on

detail-show-preferences =
    .label =
        { PLATFORM() ->
            [windows] Options
           *[other] Preferences
        }
    .accesskey =
        { PLATFORM() ->
            [windows] O
           *[other] P
        }
    .tooltiptext =
        { PLATFORM() ->
            [windows] Change this add-on’s options
           *[other] Change this add-on’s preferences
        }

detail-rating =
    .value = Rating

addon-restart-now =
    .label = Restart now

disabled-unsigned-heading =
    .value = Some add-ons have been disabled

disabled-unsigned-description =
    The following add-ons have not been verified for use in { -brand-short-name }. You can
    <label data-l10n-name="find-addons">find replacements</label> or ask the developer to get them verified.

disabled-unsigned-learn-more = Learn more about our efforts to help keep you safe online.

disabled-unsigned-devinfo =
    Developers interested in getting their add-ons verified can continue by reading our
    <label data-l10n-name="learn-more">manual</label>.

plugin-deprecation-description =
    Missing something? Some plugins are no longer supported by { -brand-short-name }. <label data-l10n-name="learn-more">Learn More.</label>

legacy-warning-show-legacy = Show legacy extensions

legacy-extensions =
    .value = Legacy Extensions

legacy-extensions-description =
    These extensions do not meet current { -brand-short-name } standards so they have been deactivated. <label data-l10n-name="legacy-learn-more">Learn about the changes to add-ons</label>

private-browsing-description2 =
    { -brand-short-name } is changing how extensions work in private browsing. Any new extensions you add to
    { -brand-short-name } won’t run by default in Private Windows. Unless you allow it in settings, the
    extension won’t work while private browsing, and won’t have access to your online activities
    there. We’ve made this change to keep your private browsing private.
    <label data-l10n-name="private-browsing-learn-more">Learn how to manage extension settings</label>

aboutaddons-sidebar =
    .heading = Add-ons

addon-category-discover = Recommendations
addon-category-discover-title =
    .title = Recommendations
addon-category-extension = Extensions
addon-category-extension-title =
    .title = Extensions
addon-category-theme = Themes
addon-category-theme-title =
    .title = Themes
addon-category-plugin = Plugins
addon-category-plugin-title =
    .title = Plugins
addon-category-dictionary = Dictionaries
addon-category-dictionary-title =
    .title = Dictionaries
addon-category-locale = Languages
addon-category-locale-title =
    .title = Languages
addon-category-available-updates = Available Updates
addon-category-available-updates-title =
    .title = Available Updates
addon-category-recent-updates = Recent Updates
addon-category-recent-updates-title =
    .title = Recent Updates
addon-category-sitepermission = Site Permissions
addon-category-sitepermission-title =
    .title = Site Permissions

addon-sitepermission-host = Site Permissions for { $host }


extensions-warning-safe-mode3 =
    .message = All add-ons have been disabled by Troubleshoot Mode.
extensions-warning-check-compatibility2 =
    .message = Add-on compatibility checking is disabled. You may have incompatible add-ons.
extensions-warning-check-compatibility-button = Enable
    .title = Enable add-on compatibility checking
extensions-warning-update-security2 =
    .message = Add-on update security checking is disabled. You may be compromised by updates.
extensions-warning-update-security-button = Enable
    .title = Enable add-on update security checking
extensions-warning-imported-addons2 =
    .message = Please finalize the installation of extensions that were imported to { -brand-short-name }.
extensions-warning-imported-addons-button = Install Extensions


addon-updates-check-for-updates = Check for Updates
    .accesskey = C
addon-updates-view-updates = View Recent Updates
    .accesskey = V


addon-updates-update-addons-automatically = Update Add-ons Automatically
    .accesskey = A


addon-updates-reset-updates-to-automatic = Reset All Add-ons to Update Automatically
    .accesskey = R
addon-updates-reset-updates-to-manual = Reset All Add-ons to Update Manually
    .accesskey = R


addon-updates-updating = Updating add-ons
addon-updates-installed = Your add-ons have been updated.
addon-updates-none-found = No updates found
addon-updates-manual-updates-found = View Available Updates


addon-install-from-file = Install Add-on From File…
    .accesskey = I
addon-install-or-update-from-file = Install or Update Add-on From File…
    .accesskey = I
addon-install-from-file-dialog-title = Select add-on to install
addon-install-from-file-filter-name = Add-ons
addon-open-about-debugging = Debug Add-ons
    .accesskey = b


addon-manage-extensions-shortcuts = Manage Extension Shortcuts
    .accesskey = S

shortcuts-no-addons = You don’t have any extensions enabled.
shortcuts-no-commands = The following extensions do not have shortcuts:
shortcuts-input =
  .placeholder = Type a shortcut
shortcuts-remove-button =
  .aria-label = Remove shortcut

shortcuts-browserAction2 = Activate toolbar button
shortcuts-pageAction = Activate page action
shortcuts-sidebarAction = Toggle the sidebar

shortcuts-modifier-mac = Include Ctrl, Alt, or ⌘
shortcuts-modifier-other = Include Ctrl or Alt
shortcuts-invalid = Invalid combination
shortcuts-letter = Type a letter
shortcuts-system = Can’t override a { -brand-short-name } shortcut

shortcuts-duplicate = Duplicate shortcut

shortcuts-duplicate-warning-message2 =
    .message = { $shortcut } is being used as a shortcut in more than one case. Duplicate shortcuts may cause unexpected behavior.

shortcuts-exists = Already in use by { $addon }

shortcuts-card-expand-button =
    { $numberToShow ->
        *[other] Show { $numberToShow } More
    }

shortcuts-card-collapse-button = Show Less

header-back-button =
    .title = Go back


discopane-intro3 =
    Extensions and themes let you customize { -brand-product-name }. They can boost privacy,
    enhance productivity, improve media, change the way { -brand-product-name } looks, and
    so much more. These small software programs are often developed by a third party. Here’s
    a selection Firefox <a data-l10n-name="learn-more-trigger">recommends</a> for
    exceptional security, performance, and functionality.

discopane-notice-recommendations2 =
    .message =
        Some of these recommendations are personalized. They are based on other
        extensions you’ve installed, profile preferences, and usage statistics.
discopane-notice-learn-more = Learn more

forced-colors-theme-notice =
    .message = Your Windows contrast settings are overriding { -brand-short-name } themes. Turn off these settings to use themes in { -brand-short-name }.

privacy-policy = Privacy Policy

created-by-author = by <a data-l10n-name="author">{ $author }</a>
user-count = Users: { $dailyUsers }
install-extension-button = Add to { -brand-product-name }
install-theme-button = Install Theme
manage-addon-button = Manage
find-more-addons = Find more add-ons
find-more-themes = Find more themes

addon-options-button =
    .aria-label = More Options


report-addon-button = Report
remove-addon-button = Remove
remove-addon-disabled-button = Can’t Be Removed <a data-l10n-name="link">Why?</a>
disable-addon-button = Disable
enable-addon-button = Enable
extension-enable-addon-button-label =
    .aria-label = Enable
preferences-addon-button =
    { PLATFORM() ->
        [windows] Options
       *[other] Preferences
    }
details-addon-button = Details
release-notes-addon-button = Release Notes
permissions-addon-button = Permissions

extension-enabled-heading = Enabled
extension-disabled-heading = Disabled

theme-enabled-heading = Enabled
theme-disabled-heading2 = Saved Themes

plugin-enabled-heading = Enabled
plugin-disabled-heading = Disabled

dictionary-enabled-heading = Enabled
dictionary-disabled-heading = Disabled

locale-enabled-heading = Enabled
locale-disabled-heading = Disabled

sitepermission-enabled-heading = Enabled
sitepermission-disabled-heading = Disabled

always-activate-button = Always Activate
never-activate-button = Never Activate

addon-detail-author-label = Author
addon-detail-version-label = Version
addon-detail-last-updated-label = Last Updated
addon-detail-homepage-label = Homepage
addon-detail-rating-label = Rating

install-postponed-message2 =
    .message = This extension will be updated when { -brand-short-name } restarts.
install-postponed-button = Update Now

addon-name-disabled = { $name } (disabled)

addon-detail-reviews-link =
    { $numberOfReviews ->
        [one] { $numberOfReviews } review
       *[other] { $numberOfReviews } reviews
    }


pending-uninstall-description2 =
    .message = { $addon } has been removed.
pending-uninstall-undo-button = Undo

addon-detail-updates-label = Allow automatic updates
addon-detail-updates-radio-default = Default
addon-detail-updates-radio-on = On
addon-detail-updates-radio-off = Off
addon-detail-update-check-label = Check for Updates
install-update-button = Update
addon-detail-group-label-updates =
    .aria-label = { addon-detail-updates-label }

addon-badge-private-browsing-allowed3 =
    .title = Allowed in private windows
addon-detail-private-browsing-help = When allowed, the extension will have access to your online activities while private browsing. <a data-l10n-name="learn-more">Learn more</a>
addon-detail-private-browsing-allow = Allow
addon-detail-private-browsing-disallow = Don’t Allow
addon-detail-group-label-private-browsing =
    .aria-label = { detail-private-browsing-label }


addon-detail-quarantined-domains-label = Run on sites with restrictions
addon-detail-quarantined-domains-help = When allowed, the extension will have access to sites restricted by { -vendor-short-name }. Allow only if you trust this extension.
addon-detail-quarantined-domains-allow = Allow
addon-detail-quarantined-domains-disallow = Don’t Allow
addon-detail-group-label-quarantined-domains =
    .aria-label = { addon-detail-quarantined-domains-label }


addon-badge-recommended4 =
  .title = Firefox only recommends extensions that meet standards for security and performance
addon-badge-line4 =
  .title = Official extension built by Mozilla. Meets security and performance standards
addon-badge-verified4 =
  .title = This extension has been reviewed to meet standards for security and performance


available-updates-heading = Available Updates
recent-updates-heading = Recent Updates

release-notes-loading = Loading…
release-notes-error = Sorry, but there was an error loading the release notes.

addon-permissions-heading = Permissions
addon-permissions-empty2 = This extension doesn’t require any permissions.
addon-permissions-required-label = Required:
addon-permissions-optional-label = Optional:
addon-permissions-learnmore = Learn more about permissions
addon-permissions-managed-by-policy = Some permissions are managed by your organization.

recommended-extensions-heading = Recommended Extensions
recommended-themes-heading = Recommended Themes

addon-sitepermissions-required = Grants the following capabilities to <span data-l10n-name="hostname">{ $hostname }</span>:

recommended-theme-1 = Feeling creative? <a data-l10n-name="link">Build your own theme with Firefox Color.</a>


extension-heading = Manage Your Extensions
theme-heading = Manage Your Themes
plugin-heading = Manage Your Plugins
dictionary-heading = Manage Your Dictionaries
locale-heading = Manage Your Languages
updates-heading = Manage Your Updates
sitepermission-heading = Manage Your Site Permissions
discover-heading = Personalize Your { -brand-short-name }
shortcuts-heading = Manage Extension Shortcuts

default-heading-search-label = Find more add-ons
addons-heading-search-input =
    .placeholder = Search addons.mozilla.org
addons-heading-search-button =
    .title = Search addons.mozilla.org
    .aria-label = Search addons.mozilla.org

addon-page-options-button =
    .title = Tools for all add-ons


details-notification-incompatible2 =
    .message = { $name } is incompatible with { -brand-short-name } { $version }.

details-notification-unsigned-and-disabled2 =
    .message = { $name } could not be verified for use in { -brand-short-name } and has been disabled.

details-notification-unsigned2 =
    .message = { $name } could not be verified for use in { -brand-short-name }. Proceed with caution.

details-notification-hard-blocked-extension =
    .message = This extension is blocked for violating Mozilla’s policies and has been disabled.
details-notification-hard-blocked-other =
    .message = This add-on is blocked for violating Mozilla’s policies and has been disabled.
details-notification-blocked-link2 = See Details

details-notification-soft-blocked-extension-disabled2 =
    .message = This extension is restricted and has been disabled. You can enable it, but this may be risky.
details-notification-soft-blocked-extension-enabled2 =
    .message = This extension is restricted. Using it may be risky.
details-notification-soft-blocked-other-disabled2 =
    .message = This add-on is restricted and has been disabled. You can enable it, but this may be risky.
details-notification-soft-blocked-other-enabled2 =
    .message = This add-on is restricted. Using it may be risky.
details-notification-softblocked-link2 = See Details

details-notification-gmp-pending2 =
    .message = { $name } will be installed shortly.


plugins-gmp-license-info = License information
plugins-gmp-privacy-info = Privacy Information

plugins-openh264-name = OpenH264 Video Codec provided by Cisco Systems, Inc.
plugins-openh264-description = This plugin is automatically installed by Mozilla to comply with the WebRTC specification and to enable WebRTC calls with devices that require the H.264 video codec. Visit https://www.openh264.org/ to view the codec source code and learn more about the implementation.

plugins-widevine-name = Widevine Content Decryption Module provided by Google Inc.
plugins-widevine-description = This plugin enables playback of encrypted media in compliance with the Encrypted Media Extensions specification. Encrypted media is typically used by sites to protect against copying of premium media content. Visit https://www.w3.org/TR/encrypted-media/ for more information on Encrypted Media Extensions.


addon-permissions-data-collection-heading = Data Collection
addon-permissions-data-collection-empty = The developer says this extension doesn’t require data collection.
addon-data-collection-provided = Info provided by the extension developer
addon-data-collection-learnmore = Learn more about data collection

permissions-data-addon-button = Permissions and data

mlmodel-extension-label = Used by the extension { $extensionName }


mlmodel-about-inference = { -brand-short-name } uses this on about:inference
mlmodel-link-preview = { -brand-short-name } uses this to generate key points when you preview links
mlmodel-pdfjs = { -brand-short-name } uses this to create alt text for images you add to PDFs
mlmodel-smart-tab-topic-engine = { -brand-short-name } uses this to suggest names for your tab groups
mlmodel-smart-tab-embedding-engine = { -brand-short-name } uses this to suggest tabs for your tab groups

mlmodel-formfill-engine = { -brand-short-name } uses this to help fill in address forms
mlmodel-speech-recognition = { -brand-short-name } uses this for on-device speech recognition

addon-category-mlmodel = On-device AI
addon-category-mlmodel-title =
  .title = On-device AI

mlmodel-heading = Manage On-Device AI Models
mlmodel-description =
  Some features and extensions in { -brand-short-name } are powered by AI models that work locally on your device. This approach protects your privacy and, in many cases, speeds up performance. <a data-l10n-name="learn-more">Learn more</a>

mlmodel-remove-addon-button =
  .aria-label = Remove
mlmodel-addon-detail-totalsize-label = File size
mlmodel-addon-detail-last-used-label = Last used
mlmodel-addon-detail-used-by-label = Used by
mlmodel-addon-detail-model-card = Model card
mlmodel-addon-detail-model-card-link-label = View on Hugging Face


find-more-addons-promo =
  .heading = Shape { -brand-product-name } your way
  .message = Add tools and styles to fit your needs and taste.

find-more-addons-promo-open-amo-button = Explore extensions and themes


find-more-extensions-promo =
  .heading = Find your next favorite extension
  .message = Customize { -brand-product-name } with tools for focus, privacy, shopping, and more.

find-more-extensions-promo-open-amo-button = Explore extensions


find-more-themes-promo =
  .heading = Find more fresh looks
  .message = Choose a style that makes { -brand-product-name } feel like yours.

find-more-themes-promo-open-amo-button = Explore themes


list-empty-get-extensions-promo =
  .heading = A few extensions go a long way
  .message = We’ve got recommendations to help you improve focus, privacy and more.

list-empty-get-extensions-promo-button = Find your first extension


themes-mode-light =
  .label = Light

themes-mode-dark =
  .label = Dark

themes-mode-device =
  .label = Device

themes-mode =
  .aria-label = Appearance

aboutaddons-themes-picker-heading =
    .heading = { -brand-product-name } themes

aboutaddons-themes-picker-see-more = Show more
aboutaddons-themes-picker-see-less = Show less


aboutaddons-themes-picker-enable-button =
    .label = Enable

aboutaddons-themes-picker-disable-button =
    .label = Disable

aboutaddons-themes-picker-install-button =
    .label = Install

aboutaddons-themes-picker-error-message =
    .message = Couldn’t update your theme. Check your connection and try again.

aboutaddons-linux-theme-colors-checkbox-label =
    .label = Use Linux system theme
