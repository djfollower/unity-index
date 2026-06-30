package com.github.dungphan.unityindex.tools.unity

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * Day 8.6 — id-parsing tests for [CSharpSymbolResolver]. The parser is the
 * load-bearing piece of the Day 8 wire contract — every `unity://csharp/`
 * id flowing in from the webview lands here first, so the rules need to be
 * pinned. PSI / resolve() are not exercised: those require an IntelliJ test
 * fixture, which is overkill for a behaviour the existing tool path
 * already covers in production.
 */
class CSharpSymbolResolverTest {

    @Test
    fun `rejects ids without the unity csharp prefix`() {
        assertNull(CSharpSymbolResolver.parse(""))
        assertNull(CSharpSymbolResolver.parse("T:Foo.Bar"))
        assertNull(CSharpSymbolResolver.parse("unity://script/Assets/Foo.cs"))
        assertNull(CSharpSymbolResolver.parse("unity://csharp"))
    }

    @Test
    fun `parses T type ids`() {
        val p = CSharpSymbolResolver.parse("unity://csharp/T:Foo.Bar")
        assertNotNull(p)
        assertEquals(CSharpSymbolResolver.SymbolKind.TYPE, p!!.kind)
        assertEquals("Foo.Bar", p.typeName)
        assertNull(p.methodName)
    }

    @Test
    fun `parses M method ids and splits type vs method`() {
        val p = CSharpSymbolResolver.parse("unity://csharp/M:Foo.Bar.Baz(System.Int32)")
        assertNotNull(p)
        assertEquals(CSharpSymbolResolver.SymbolKind.METHOD, p!!.kind)
        assertEquals("Foo.Bar", p.typeName)
        assertEquals("Baz", p.methodName)
    }

    @Test
    fun `M ids without a dot fall back to OTHER`() {
        val p = CSharpSymbolResolver.parse("unity://csharp/M:Bare")
        assertNotNull(p)
        assertEquals(CSharpSymbolResolver.SymbolKind.OTHER, p!!.kind)
    }

    @Test
    fun `unknown DocId prefixes parse as OTHER`() {
        // The wire schema today only mints T: and M:. F:/P:/E:/N: are valid
        // DocumentationCommentId prefixes but not part of our graph ID
        // taxonomy — the resolver tags them OTHER so the harvester can route
        // them straight to `unresolved_ids` rather than failing.
        for (prefix in listOf("F", "P", "E", "N")) {
            val p = CSharpSymbolResolver.parse("unity://csharp/$prefix:Foo.Bar")
            assertNotNull(p, "prefix $prefix should parse")
            assertEquals(CSharpSymbolResolver.SymbolKind.OTHER, p!!.kind)
        }
    }

    @Test
    fun `typeId and methodId encoders match the parse format`() {
        val tid = CSharpSymbolResolver.typeId("Foo.Bar")
        assertEquals("unity://csharp/T:Foo.Bar", tid)
        assertEquals(
            CSharpSymbolResolver.SymbolKind.TYPE,
            CSharpSymbolResolver.parse(tid)?.kind,
        )

        val mid = CSharpSymbolResolver.methodId("Foo.Bar", "Baz")
        assertEquals("unity://csharp/M:Foo.Bar.Baz", mid)
        val parsed = CSharpSymbolResolver.parse(mid)
        assertEquals(CSharpSymbolResolver.SymbolKind.METHOD, parsed?.kind)
        assertEquals("Foo.Bar", parsed?.typeName)
        assertEquals("Baz", parsed?.methodName)
    }

    @Test
    fun `whitespace is trimmed before prefix check`() {
        val p = CSharpSymbolResolver.parse("  unity://csharp/T:Foo  ")
        assertNotNull(p)
        assertEquals("Foo", p!!.typeName)
    }
}
