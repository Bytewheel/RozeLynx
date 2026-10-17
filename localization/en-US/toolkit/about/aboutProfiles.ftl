

profiles-title = About Profiles
profiles-subtitle = This page helps you to manage your profiles. Each profile is a separate world which contains separate history, bookmarks, settings and add-ons.
profiles-create = Create a New Profile
profiles-restart-title = Restart
profiles-restart-in-safe-mode = Restart with Add-ons Disabled…
profiles-restart-normal = Restart normally…
profiles-conflict = Another copy of { -brand-product-name } has made changes to profiles. You must restart { -brand-short-name } before making more changes.
profiles-flush-fail-title = Changes not saved
profiles-flush-conflict = { profiles-conflict }
profiles-flush-failed = An unexpected error has prevented your changes from being saved.
profiles-flush-restart-button = Restart { -brand-short-name }

profiles-name = Profile: { $name }
profiles-is-default = Default Profile
profiles-rootdir = Root Directory

profiles-localdir = Local Directory
profiles-current-profile = This is the profile in use and it cannot be deleted.
profiles-in-use-profile = This profile is in use in another application and it cannot be deleted.
profiles-cannot-delete-profile = Can’t delete a profile that is linked to other profiles.

profiles-rename = Rename
profiles-remove = Remove
profiles-set-as-default = Set as default profile
profiles-launch-profile = Launch profile in new browser

profiles-cannot-set-as-default-title = Unable to set default
profiles-cannot-set-as-default-message = The default profile cannot be changed for { -brand-short-name }.

profiles-yes = yes
profiles-no = no

profiles-rename-profile-title = Rename Profile
profiles-rename-profile = Rename profile { $name }

profiles-invalid-profile-name-title = Invalid profile name
profiles-invalid-profile-name = The profile name “{ $name }” is not allowed.

profiles-delete-profile-title = Delete Profile
profiles-delete-profile-confirm =
    Deleting a profile will remove the profile from the list of available profiles and cannot be undone.
    You may also choose to delete the profile data files, including your settings, certificates and other user-related data. This option will delete the folder “{ $dir }” and cannot be undone.
    Would you like to delete the profile data files?
profiles-delete-files = Delete Files
profiles-dont-delete-files = Don’t Delete Files

profiles-delete-profile-failed-title = Error
profiles-delete-profile-failed-message = There was an error while attempting to delete this profile.


profiles-opendir =
    { PLATFORM() ->
        [macos] Show in Finder
        [windows] Open Folder
       *[other] Open Directory
    }
