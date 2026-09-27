export interface PlatformInfo {
  isAndroid: boolean
  isMobile: boolean
  isDesktop: boolean
}

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: { mobile?: boolean; platform?: string }
}

/**
 * Device class affects only which setup actions we show. It does not change
 * polling, stored summaries, or any wellness interpretation.
 */
export function platformInfo(navigatorValue: Pick<Navigator, 'userAgent'> & Partial<NavigatorWithUserAgentData>): PlatformInfo {
  const userAgent = navigatorValue.userAgent ?? ''
  const platform = navigatorValue.userAgentData?.platform ?? ''
  const isAndroid = /android/i.test(`${userAgent} ${platform}`)
  const isMobile = Boolean(navigatorValue.userAgentData?.mobile)
    || isAndroid
    || /iphone|ipad|ipod|mobile/i.test(userAgent)

  return { isAndroid, isMobile, isDesktop: !isMobile }
}
