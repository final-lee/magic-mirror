import { describe, expect, it } from "vitest";
import { fromPlain, itemSize, plainItem, valueSize } from "./value";
describe("DynamoDB values",()=>{
 it("keeps unsafe numbers as strings and recurses",()=>{expect(plainItem({n:{N:"9007199254740993"},m:{M:{a:{L:[{BOOL:true}]}}}})).toEqual({n:"9007199254740993",m:{a:[true]}});expect(fromPlain({a:[true,null]})).toEqual({M:{a:{L:[{BOOL:true},{NULL:true}]}}});});
 it("includes UTF-8 names and nested overhead",()=>{expect(itemSize({"키":{S:"가"}})).toBe(6);expect(valueSize({L:[{S:"x"}]})).toBe(5);expect(valueSize({B:"YWJj"})).toBe(3);});
});
