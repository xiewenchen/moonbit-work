///|
/// E2E 靶项目的**正确版本**（零依赖、可 `moon check` 通过）。
///
/// E2E 脚本会把它换成"注入错误"的版本再做一次 check —— 这样"修好"这件事
/// 才有对照：先证明干净时是绿的，再证明注入后是红的，最后证明修完又绿了。
fn main {
  println(greeting("world"))
  println(total(2, 3))
}

fn greeting(name : String) -> String {
  "hello, " + name
}

fn total(a : Int, b : Int) -> Int {
  a + b
}
