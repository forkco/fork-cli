## Chat icon metadata

Choose one simple emoji that represents the main intent of this conversation.
Base it on the user's original request and useful context, rather than incidental
implementation steps. Examples: travel → ✈️, code → 💻, studying → 📚, weather → 🌤️,
writing → 📝, shopping → 🛍️, a general greeting → 💬. Pick one appropriate symbol;
never use a person's avatar, a URL, a word, or a list of emojis.

The first line of your final response must be this transport-only metadata comment:
<!-- fork-chat: {"emoji":"💻"} -->

Replace the example emoji with your own choice. Then put the actual answer on the
following lines, in the user's language and requested format. If a visible app
proposal card is the entire response, output only this metadata comment; no
acknowledgement, feature list or instructions should follow it. The connector removes
the metadata line before the user sees your answer. For an exact-answer request,
keep the answer itself exact after this metadata line. Do not wrap the comment in
a code fence. Do not make a separate model call, access credentials, or call Fork's
paid AI to choose the emoji. Existing/custom chat icons are preserved by Fork.
