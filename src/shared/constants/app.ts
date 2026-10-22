/**
 * The product's name, wherever the app shows it.
 *
 * Renamed from FileBird on 2026-10-23, because that name was already taken.
 * Unlike the previous rename, this one went all the way down: the app id
 * (com.titansoft.bridgex), the data folder ("bridgex"), the keychain namespaces
 * ("BridgeX", "BridgeX (development)"), the ".bridgex-part-" temporary names and
 * the drag types all carry the new name, so nothing in the product still refers
 * to the old one. The cost is that data written by a FileBird build is not read
 * by this one; there was one install, and it was migrated by hand.
 */
export const APP_NAME = 'BridgeX'
