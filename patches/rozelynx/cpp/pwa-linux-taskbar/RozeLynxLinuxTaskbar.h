#ifndef mozilla_RozeLynxLinuxTaskbar_h
#define mozilla_RozeLynxLinuxTaskbar_h

#include "mozilla/AlreadyAddRefed.h"
#include "nsIRozeLynxLinuxTaskbar.h"

namespace mozilla {

class RozeLynxLinuxTaskbar final : public nsIRozeLynxLinuxTaskbar {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIROZELYNXLINUXTASKBAR

  RozeLynxLinuxTaskbar();

 private:
  ~RozeLynxLinuxTaskbar();
};

}  // namespace mozilla

#endif  // mozilla_RozeLynxLinuxTaskbar_h
