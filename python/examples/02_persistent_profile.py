"""Profiles: one identity per name, frozen forever, unlimited and free.

Run it twice. The second run reports the same fingerprint and finds the cookie
the first run left behind - because a profile is a real directory on disk, not
a fresh incognito context.

    python examples/02_persistent_profile.py
"""

from antibrow import launch, list_profiles, profile_dir

PROFILE = "demo-persistent"


def main() -> None:
    with launch(profile=PROFILE, label="demo") as browser:
        # The frozen identity - identical on every launch of this profile.
        persona = browser.persona
        print("profile dir:", browser.profile_dir)
        print("seed:       ", persona.seed)
        print("ua:         ", persona.ua)
        print("gpu:        ", persona.gpu_renderer)
        print("screen:     ", persona.screen_w, "x", persona.screen_h, "@", persona.device_pixel_ratio)

        page = browser.new_page()
        page.goto("https://example.com")

        previous = page.evaluate("localStorage.getItem('antibrow-visits')")
        visits = int(previous or 0) + 1
        page.evaluate("v => localStorage.setItem('antibrow-visits', v)", str(visits))
        print("visits recorded in this profile:", visits)

    # Profiles are just directories - enumerate, copy, delete them as you like.
    print("\nprofile on disk:", profile_dir(PROFILE))
    print("all profiles:   ", list_profiles())
    print("\nRun this script again: the seed stays the same and visits goes up.")


if __name__ == "__main__":
    main()
