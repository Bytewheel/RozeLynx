
btp-warning-tracker-classified =
    { $gracePeriodSeconds ->
        *[other] “{ $siteHost }” has been classified as a bounce tracker. If it does not receive user activation within the next { $gracePeriodSeconds } seconds it will have its state purged.
    }

btp-warning-tracker-purged = The state of “{ $siteHost }” was recently purged because it was detected as a bounce tracker.
