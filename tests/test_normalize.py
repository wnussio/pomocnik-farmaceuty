from app.normalize import query_tokens, simple, substance_key


def test_salt_variants_share_key():
    assert substance_key("Amlodipini besilas") == substance_key("Amlodipinum") == "amlodipin"
    assert substance_key("Atorvastatinum calcicum trihydricum") == substance_key("Atorvastatinum")
    assert substance_key("tert-Butylamini perindoprilum") == substance_key("Perindoprilum argininum")
    assert substance_key("Lithii carbonas") == substance_key("Lithium")


def test_polish_spelling_matches_latin():
    assert query_tokens("amlodypina") == [substance_key("Amlodipinum")]
    assert query_tokens("lewotyroksyna") == [substance_key("Levothyroxinum natricum")]
    assert query_tokens("klarytromycyna") == [substance_key("Clarithromycinum")]
    assert query_tokens("kwas acetylosalicylowy") == [substance_key("Acidum acetylsalicylicum")]


def test_acid_and_salt_forms():
    assert substance_key("Acidum valproicum") == substance_key("Natrii valproas")
    assert substance_key("Acidum alendronicum") == substance_key("Natrii alendronas")


def test_simple_strips_diacritics():
    assert simple("Żel Łagodzący – 5%") == "zel lagodzacy 5"
