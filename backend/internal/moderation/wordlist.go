package moderation

// blockedWords is deliberately short: common English profanity and slurs,
// plus common Hindi/Hinglish abuse in Latin script. Matching is whole-word
// (with leetspeak and stretched letters undone); words of seven letters or
// more also match inside other text. Edit freely.
var blockedWords = []string{
	// English
	"fuck", "fucker", "fucking", "fuckin", "motherfucker", "fck", "fuk",
	"shit", "shithead", "bullshit",
	"bitch", "bastard", "cunt", "twat", "wanker", "prick",
	"dick", "dickhead", "cock", "cocksucker", "pussy", "asshole", "arsehole",
	"slut", "whore", "rape", "rapist",
	"nigger", "nigga", "faggot", "fag", "retard", "tranny", "chink", "spic", "kike",
	// Hindi / Hinglish
	"chutiya", "chutia", "chutiye", "madarchod", "maderchod", "madharchod",
	"bhenchod", "behenchod", "bhanchod", "bhosdike", "bhosadike", "bhosdi", "bsdk",
	"gandu", "gaandu", "randi", "lund", "lauda", "lavda", "lodu", "chodu", "harami",
}
