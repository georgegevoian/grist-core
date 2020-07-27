# -*- coding: utf-8 -*-
# pylint: disable=line-too-long

import logger
import testutil
import test_engine

log = logger.Logger(__name__, logger.INFO)

class TestTypes(test_engine.EngineTestCase):
  sample = testutil.parse_test_sample({
    "SCHEMA": [
      [1, "Types", [
        [21, "text",    "Text",    False, "", "", ""],
        [22, "numeric", "Numeric", False, "", "", ""],
        [23, "int",     "Int",     False, "", "", ""],
        [24, "bool",    "Bool",    False, "", "", ""],
        [25, "date",    "Date",    False, "", "", ""]
      ]],
      [2, "Formulas", [
        [30, "division", "Any",    True,  "Types.lookupOne(id=18).numeric / 2", "", ""]
      ]]
    ],
    "DATA": {
      "Types": [
        ["id", "text",     "numeric",  "int",      "bool",     "date"],
        [11,   "New York", "New York", "New York", "New York", "New York"],
        [12,   "Chîcágö",  "Chîcágö",  "Chîcágö",  "Chîcágö",  "Chîcágö"],
        [13,   False,      False,      False,      False,      False],
        [14,   True,       True,       True,       True,       True],
        [15,   1509556595, 1509556595, 1509556595, 1509556595, 1509556595],
        [16,   8.153,      8.153,      8.153,      8.153,      8.153],
        [17,   0,          0,          0,          0,          0],
        [18,   1,          1,          1,          1,          1],
        [19,   "",         "",         "",         "",         ""],
        [20,   None,       None,       None,       None,       None]],
      "Formulas": [
        ["id"],
        [1]]
    },
  })
  all_row_ids = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]

  def test_update_typed_cells(self):
    """
    Tests that updated typed values are set as expected in the sandbox. Types should follow
    the rules:
     - After updating a cell with a value of a type compatible to the column type,
       the cell value should have the column's standard type
     - Otherwise, the cell value should have the type AltText
    """
    self.load_sample(self.sample)

    out_actions = self.apply_user_action(["BulkUpdateRecord", "Types", self.all_row_ids, {
      "text":    [None, "", 1, 0, 8.153, 1509556595, True, False, u"Chîcágö", "New York"],
      "numeric": [None, "", 1, 0, 8.153, 1509556595, True, False, u"Chîcágö", "New York"],
      "int":     [None, "", 1, 0, 8.153, 1509556595, True, False, u"Chîcágö", "New York"],
      "bool":    [None, "", 1, 0, 8.153, 1509556595, True, False, u"Chîcágö", "New York"],
      "date":    [None, "", 1, 0, 8.153, 1509556595, True, False, u"2019-01-22 00:47:39", "New York"]
    }])

    self.assertPartialOutActions(out_actions, {
      "stored": [["BulkUpdateRecord", "Types", self.all_row_ids, {
        "text":    [None,"","1","0","8.153","1509556595","True","False","Chîcágö","New York"],
        "numeric": [None, None, 1.0, 0.0, 8.153, 1509556595.0, 1.0, 0.0, "Chîcágö", "New York"],
        "int":     [None, None, 1, 0, 8, 1509556595, 1, 0, "Chîcágö", "New York"],
        "bool":    [False, False, True, False, True, True, True, False, "Chîcágö", "New York"],
        "date":    [None, None, 1.0, 0.0, 8.153, 1509556595.0, 1.0, 0.0, 1548115200.0, "New York"]
      }]],
      "undo": [["BulkUpdateRecord", "Types", self.all_row_ids, {
        "text":    ["New York", "Chîcágö", False, True, 1509556595, 8.153, 0, 1, "", None],
        "numeric": ["New York", "Chîcágö", False, True, 1509556595, 8.153, 0, 1, "", None],
        "int":     ["New York", "Chîcágö", False, True, 1509556595, 8.153, 0, 1, "", None],
        "bool":    ["New York", "Chîcágö", False, True, 1509556595, 8.153, False, True, "", None],
        "date":    ["New York", "Chîcágö", False, True, 1509556595, 8.153, 0, 1, "", None]
      }]]
    })

    self.assertTableData("Types", data=[
      ["id", "text",       "numeric",  "int",      "bool",     "date"],
      [11,   None,         None,       None,       False,      None],
      [12,   "",           None,       None,       False,      None],
      [13,   "1",          1.0,        1,          True,       1.0],
      [14,   "0",          0.0,        0,          False,      0.0],
      [15,   "8.153",      8.153,      8,          True,       8.153],
      [16,   "1509556595", 1509556595, 1509556595, True,       1509556595.0],
      [17,   "True",       1.0,        1,          True,       1.0],
      [18,   "False",      0.0,        0,          False,      0.0],
      [19,   "Chîcágö",    "Chîcágö",  "Chîcágö",  "Chîcágö",  1548115200.0],
      [20,   "New York",   "New York", "New York", "New York", "New York"]
    ])


  def test_text_conversions(self):
    """
    Tests that column type changes occur as expected in the sandbox:
     - Resulting cell values should all be Text
     - Only non-compatible values should appear in the resulting BulkUpdateRecord
    """
    self.load_sample(self.sample)

    # Test Text -> Text conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "text", { "type" : "Text" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [],
      "undo": []
    })

    # Test Numeric -> Text conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "numeric", { "type" : "Text" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "numeric", {"type": "Text"}],
        ["BulkUpdateRecord", "Types", [13, 14, 15, 16, 17, 18],
          {"numeric": ["False", "True", "1509556595.0", "8.153", "0.0", "1.0"]}],
        ["UpdateRecord", "_grist_Tables_column", 22, {"type": "Text"}],
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [13, 14, 15, 16, 17, 18],
          {"numeric": [False, True, 1509556595, 8.153, 0, 1]}],
        ["ModifyColumn", "Types", "numeric", {"type": "Numeric"}],
        ["UpdateRecord", "_grist_Tables_column", 22, {"type": "Numeric"}],
      ]
    })

    # Test Int -> Text conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "int", { "type" : "Text" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "int", {"type": "Text"}],
        ["BulkUpdateRecord", "Types", [13, 14, 15, 16, 17, 18],
          {"int": ["False", "True", "1509556595", "8.153", "0", "1"]}],
        ["UpdateRecord", "_grist_Tables_column", 23, {"type": "Text"}],
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [13, 14, 15, 16, 17, 18],
          {"int": [False, True, 1509556595, 8.153, 0, 1]}],
        ["ModifyColumn", "Types", "int", {"type": "Int"}],
        ["UpdateRecord", "_grist_Tables_column", 23, {"type": "Int"}],
      ]
    })

    # Test Bool -> Text
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "bool", { "type" : "Text" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "bool", {"type": "Text"}],
        ["BulkUpdateRecord", "Types", [13, 14, 15, 16, 17, 18],
          {"bool": ["False", "True", "1509556595", "8.153", "False", "True"]}],
        ["UpdateRecord", "_grist_Tables_column", 24, {"type": "Text"}],
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [13, 14, 15, 16, 17, 18],
          {"bool": [False, True, 1509556595, 8.153, False, True]}],
        ["ModifyColumn", "Types", "bool", {"type": "Bool"}],
        ["UpdateRecord", "_grist_Tables_column", 24, {"type": "Bool"}],
      ]
    })

    # Test Date -> Text
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "date", { "type" : "Text" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "date", {"type": "Text"}],
        ["BulkUpdateRecord", "Types", [13, 14, 15, 16, 17, 18],
          {"date": ["False", "True", "1509556595", "8.153", "0", "1"]}],
        ["UpdateRecord", "_grist_Tables_column", 25, {"type": "Text"}]
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [13, 14, 15, 16, 17, 18],
          {"date": [False, True, 1509556595, 8.153, 0, 1]}],
        ["ModifyColumn", "Types", "date", {"type": "Date"}],
        ["UpdateRecord", "_grist_Tables_column", 25, {"type": "Date"}]
      ]
    })

    # Assert that the final table is as expected
    self.assertTableData("Types", data=[
      ["id", "text",      "numeric",   "int",       "bool",      "date"],
      [11,   "New York",  "New York",  "New York",  "New York",  "New York"],
      [12,   "Chîcágö",   "Chîcágö",   "Chîcágö",   "Chîcágö",   "Chîcágö"],
      [13,   False,       "False",     "False",     "False",     "False"],
      [14,   True,        "True",      "True",      "True",      "True"],
      [15,   1509556595,  "1509556595.0","1509556595","1509556595","1509556595"],
      [16,   8.153,       "8.153",     "8.153",     "8.153",     "8.153"],
      [17,   0,           "0.0",       "0",         "False",     "0"],
      [18,   1,           "1.0",       "1",         "True",      "1"],
      [19,   "",          "",          "",          "",          ""],
      [20,   None,        None,        None,        None,        None]
    ])


  def test_numeric_conversions(self):
    """
    Tests that column type changes occur as expected in the sandbox:
     - Resulting cell values should all be of type Numeric or AltText
     - Only non-compatible values should appear in the resulting BulkUpdateRecord
    """
    self.load_sample(self.sample)

    # Test Text -> Numeric conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "text", { "type" : "Numeric" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "text", {"type": "Numeric"}],
        ["BulkUpdateRecord", "Types", [13, 14, 15, 17, 18, 19],
          {"text": [0.0, 1.0, 1509556595.0, 0.0, 1.0, None]}],
        ["UpdateRecord", "_grist_Tables_column", 21, {"type": "Numeric"}],
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [13, 14, 15, 17, 18, 19],
          {"text": [False, True, 1509556595, 0, 1, ""]}],
        ["ModifyColumn", "Types", "text", {"type": "Text"}],
        ["UpdateRecord", "_grist_Tables_column", 21, {"type": "Text"}],
      ]
    })

    # Test Numeric -> Numeric conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "numeric", {"type": "Numeric"}])
    self.assertPartialOutActions(out_actions, {
      "stored": [],
      "undo": []
    })

    # Test Int -> Numeric conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "int", { "type" : "Numeric" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "int", {"type": "Numeric"}],
        ["BulkUpdateRecord", "Types", [13, 14, 15, 17, 18, 19],
          {"int": [0.0, 1.0, 1509556595.0, 0.0, 1.0, None]}],
        ["UpdateRecord", "_grist_Tables_column", 23, {"type": "Numeric"}],
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [13, 14, 15, 17, 18, 19],
          {"int": [False, True, 1509556595, 0, 1, ""]}],
        ["ModifyColumn", "Types", "int", {"type": "Int"}],
        ["UpdateRecord", "_grist_Tables_column", 23, {"type": "Int"}],
      ]
    })

    # Test Bool -> Numeric conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "bool", { "type" : "Numeric" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "bool", {"type": "Numeric"}],
        ["BulkUpdateRecord", "Types", [13, 14, 15, 17, 18, 19],
          {"bool": [0.0, 1.0, 1509556595.0, 0.0, 1.0, None]}],
        ["UpdateRecord", "_grist_Tables_column", 24, {"type": "Numeric"}],
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [13, 14, 15, 17, 18, 19],
          {"bool": [False, True, 1509556595, False, True, ""]}],
        ["ModifyColumn", "Types", "bool", {"type": "Bool"}],
        ["UpdateRecord", "_grist_Tables_column", 24, {"type": "Bool"}],
      ]
    })

    # Test Date -> Numeric conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "date", { "type" : "Numeric" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "date", {"type": "Numeric"}],
        ["BulkUpdateRecord", "Types", [13, 14, 15, 17, 18, 19],
          {"date": [0.0, 1.0, 1509556595.0, 0.0, 1.0, None]}],
        ["UpdateRecord", "_grist_Tables_column", 25, {"type": "Numeric"}]
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [13, 14, 15, 17, 18, 19],
          {"date": [False, True, 1509556595, 0, 1, ""]}],
        ["ModifyColumn", "Types", "date", {"type": "Date"}],
        ["UpdateRecord", "_grist_Tables_column", 25, {"type": "Date"}]
      ]
    })

    # Assert that the final table is as expected
    self.assertTableData("Types", data=[
      ["id", "text",     "numeric",  "int",      "bool",     "date"],
      [11,   "New York", "New York", "New York", "New York", "New York"],
      [12,   "Chîcágö",  "Chîcágö",  "Chîcágö",  "Chîcágö",  "Chîcágö"],
      [13,   0.0,        False,      0.0,        0.0,        0.0],
      [14,   1.0,        True,       1.0,        1.0,        1.0],
      [15,   1509556595, 1509556595, 1509556595, 1509556595, 1509556595],
      [16,   8.153,      8.153,      8.153,      8.153,      8.153],
      [17,   0.0,        0.0,        0.0,        0.0,        0.0],
      [18,   1.0,        1.0,        1.0,        1.0,        1.0],
      [19,   None,       "",         None,       None,       None],
      [20,   None,       None,       None,       None,       None],
    ])


  def test_int_conversions(self):
    """
    Tests that column type changes occur as expected in the sandbox:
     - Resulting cell values should all be of type Int or AltText
     - Only non-compatible values should appear in the resulting BulkUpdateRecord
    """
    self.load_sample(self.sample)

    # Test Text -> Int conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "text", { "type" : "Int" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "text", {"type": "Int"}],
        ["BulkUpdateRecord", "Types", [13, 14, 16, 19], {"text": [0, 1, 8, None]}],
        ["UpdateRecord", "_grist_Tables_column", 21, {"type": "Int"}],
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [13, 14, 16, 19],
          {"text": [False, True, 8.153, ""]}],
        ["ModifyColumn", "Types", "text", {"type": "Text"}],
        ["UpdateRecord", "_grist_Tables_column", 21, {"type": "Text"}],
      ]
    })

    # Test Numeric -> Int conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "numeric", { "type" : "Int" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "numeric", {"type": "Int"}],
        ["BulkUpdateRecord", "Types", [13, 14, 15, 16, 17, 18, 19],
         {"numeric": [0, 1, 1509556595, 8, 0, 1, None]}],
        ["UpdateRecord", "_grist_Tables_column", 22, {"type": "Int"}],
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [13, 14, 15, 16, 17, 18, 19],
          {"numeric": [False, True, 1509556595.0, 8.153, 0.0, 1.0, ""]}],
        ["ModifyColumn", "Types", "numeric", {"type": "Numeric"}],
        ["UpdateRecord", "_grist_Tables_column", 22, {"type": "Numeric"}],
      ]
    })

    # Test Int -> Int conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "int", { "type" : "Int" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [],
      "undo": []
    })

    # Test Bool -> Int conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "bool", { "type" : "Int" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "bool", {"type": "Int"}],
        ["BulkUpdateRecord", "Types", [13, 14, 16, 17, 18, 19],
          {"bool": [0, 1, 8, 0, 1, None]}],
        ["UpdateRecord", "_grist_Tables_column", 24, {"type": "Int"}],
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [13, 14, 16, 17, 18, 19],
          {"bool": [False, True, 8.153, False, True, ""]}],
        ["ModifyColumn", "Types", "bool", {"type": "Bool"}],
        ["UpdateRecord", "_grist_Tables_column", 24, {"type": "Bool"}],
      ]
    })

    # Test Date -> Int conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "date", { "type" : "Int" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "date", {"type": "Int"}],
        ["BulkUpdateRecord", "Types", [13, 14, 16, 19], {"date": [0, 1, 8, None]}],
        ["UpdateRecord", "_grist_Tables_column", 25, {"type": "Int"}]
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [13, 14, 16, 19],
          {"date": [False, True, 8.153, ""]}],
        ["ModifyColumn", "Types", "date", {"type": "Date"}],
        ["UpdateRecord", "_grist_Tables_column", 25, {"type": "Date"}]
      ]
    })

    # Assert that the final table is as expected
    self.assertTableData("Types", data=[
      ["id", "text",     "numeric",  "int",      "bool",     "date"],
      [11,   "New York", "New York", "New York", "New York", "New York"],
      [12,   "Chîcágö",  "Chîcágö",  "Chîcágö",  "Chîcágö",  "Chîcágö"],
      [13,   0,          0,          False,      0,          0],
      [14,   1,          1,          True,       1,          1],
      [15,   1509556595, 1509556595, 1509556595, 1509556595, 1509556595],
      [16,   8,          8,          8.153,      8,          8],
      [17,   0,          0,          0,          0,          0],
      [18,   1,          1,          1,          1,          1],
      [19,   None,       None,       "",         None,       None],
      [20,   None,       None,       None,       None,       None]
    ])


  def test_bool_conversions(self):
    """
    Tests that column type changes occur as expected in the sandbox:
     - Resulting cell values should all be of type Bool or AltText
     - Only non-compatible values should appear in the resulting BulkUpdateRecord
    """
    self.load_sample(self.sample)

    # Test Text -> Bool conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "text", { "type" : "Bool" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "text", {"type": "Bool"}],
        ["BulkUpdateRecord", "Types", [15, 16, 17, 18, 19, 20],
          {"text": [True, True, False, True, False, False]}],
        ["UpdateRecord", "_grist_Tables_column", 21, {"type": "Bool"}],
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [15, 16, 17, 18, 19, 20],
          {"text": [1509556595, 8.153, 0, 1, "", None]}],
        ["ModifyColumn", "Types", "text", {"type": "Text"}],
        ["UpdateRecord", "_grist_Tables_column", 21, {"type": "Text"}],
      ]
    })

    # Test Numeric -> Bool conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "numeric", { "type" : "Bool" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "numeric", {"type": "Bool"}],
        ["BulkUpdateRecord", "Types", [15, 16, 17, 18, 19, 20],
          {"numeric": [True, True, False, True, False, False]}],
        ["UpdateRecord", "_grist_Tables_column", 22, {"type": "Bool"}],
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [15, 16, 17, 18, 19, 20],
          {"numeric": [1509556595.0, 8.153, 0.0, 1.0, "", None]}],
        ["ModifyColumn", "Types", "numeric", {"type": "Numeric"}],
        ["UpdateRecord", "_grist_Tables_column", 22, {"type": "Numeric"}],
      ]
    })

    # Test Int -> Bool conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "int", { "type" : "Bool" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "int", {"type": "Bool"}],
        ["BulkUpdateRecord", "Types", [15, 16, 17, 18, 19, 20],
          {"int": [True, True, False, True, False, False]}],
        ["UpdateRecord", "_grist_Tables_column", 23, {"type": "Bool"}],
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [15, 16, 17, 18, 19, 20],
          {"int": [1509556595, 8.153, 0, 1, "", None]}],
        ["ModifyColumn", "Types", "int", {"type": "Int"}],
        ["UpdateRecord", "_grist_Tables_column", 23, {"type": "Int"}],
      ]
    })

    # Test Bool -> Bool conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "bool", { "type" : "Bool" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [],
      "undo": []
    })

    # Test Date -> Bool conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "date", { "type" : "Bool" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "date", {"type": "Bool"}],
        ["BulkUpdateRecord", "Types", [15, 16, 17, 18, 19, 20],
          {"date": [True, True, False, True, False, False]}],
        ["UpdateRecord", "_grist_Tables_column", 25, {"type": "Bool"}]
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [15, 16, 17, 18, 19, 20],
          {"date": [1509556595, 8.153, 0, 1, "", None]}],
        ["ModifyColumn", "Types", "date", {"type": "Date"}],
        ["UpdateRecord", "_grist_Tables_column", 25, {"type": "Date"}]
      ]
    })

    # Assert that the final table is as expected
    self.assertTableData("Types", data=[
      ["id", "text",     "numeric",  "int",      "bool",     "date"],
      [11,   "New York", "New York", "New York", "New York", "New York"],
      [12,   "Chîcágö",  "Chîcágö",  "Chîcágö",  "Chîcágö",  "Chîcágö"],
      [13,   False,      False,      False,      False,      False],
      [14,   True,       True,       True,       True,       True],
      [15,   True,       True,       True,       1509556595, True],
      [16,   True,       True,       True,       8.153,      True],
      [17,   False,      False,      False,      0,          False],
      [18,   True,       True,       True,       1,          True],
      [19,   False,      False,      False,      "",         False],
      [20,   False,      False,      False,      None,       False]
    ])


  def test_date_conversions(self):
    """
    Tests that column type changes occur as expected in the sandbox:
     - Resulting cell values should all be of type Date or AltText
     - Only non-compatible values should appear in the resulting BulkUpdateRecord
    """
    self.load_sample(self.sample)

    # Test Text -> Date conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "text", { "type" : "Date" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "text", {"type": "Date"}],
        ["BulkUpdateRecord", "Types", [13, 14, 15, 17, 18, 19],
          {"text": [0.0, 1.0, 1509556595.0, 0.0, 1.0, None]}],
        ["UpdateRecord", "_grist_Tables_column", 21, {"type": "Date"}],
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [13, 14, 15, 17, 18, 19],
          {"text": [False, True, 1509556595, 0, 1, ""]}],
        ["ModifyColumn", "Types", "text", {"type": "Text"}],
        ["UpdateRecord", "_grist_Tables_column", 21, {"type": "Text"}],
      ]
    })

    # Test Numeric -> Date conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "numeric", { "type" : "Date" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "numeric", {"type": "Date"}],
        ["BulkUpdateRecord", "Types", [13, 14, 19],
          {"numeric": [0.0, 1.0, None]}],
        ["UpdateRecord", "_grist_Tables_column", 22, {"type": "Date"}],
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [13, 14, 19],
          {"numeric": [False, True, ""]}],
        ["ModifyColumn", "Types", "numeric", {"type": "Numeric"}],
        ["UpdateRecord", "_grist_Tables_column", 22, {"type": "Numeric"}],
      ]
    })

    # Test Int -> Date conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "int", { "type" : "Date" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "int", {"type": "Date"}],
        ["BulkUpdateRecord", "Types", [13, 14, 15, 17, 18, 19],
          {"int": [0.0, 1.0, 1509556595.0, 0.0, 1.0, None]}],
        ["UpdateRecord", "_grist_Tables_column", 23, {"type": "Date"}],
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [13, 14, 15, 17, 18, 19],
          {"int": [False, True, 1509556595, 0, 1, ""]}],
        ["ModifyColumn", "Types", "int", {"type": "Int"}],
        ["UpdateRecord", "_grist_Tables_column", 23, {"type": "Int"}],
      ]
    })

    # Test Bool -> Date conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "bool", { "type" : "Date" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [
        ["ModifyColumn", "Types", "bool", {"type": "Date"}],
        ["BulkUpdateRecord", "Types", [13, 14, 15, 17, 18, 19],
          {"bool": [0.0, 1.0, 1509556595.0, 0.0, 1.0, None]}],
        ["UpdateRecord", "_grist_Tables_column", 24, {"type": "Date"}]
      ],
      "undo": [
        ["BulkUpdateRecord", "Types", [13, 14, 15, 17, 18, 19],
          {"bool": [False, True, 1509556595, False, True, ""]}],
        ["ModifyColumn", "Types", "bool", {"type": "Bool"}],
        ["UpdateRecord", "_grist_Tables_column", 24, {"type": "Bool"}]
      ]
    })

    # Test Date -> Date conversion
    out_actions = self.apply_user_action(["ModifyColumn", "Types", "date", { "type" : "Date" }])
    self.assertPartialOutActions(out_actions, {
      "stored": [],
      "undo": []
    })

    # Assert that the final table is as expected
    self.assertTableData("Types", data=[
      ["id", "text",     "numeric",  "int",      "bool",     "date"],
      [11,   "New York", "New York", "New York", "New York", "New York"],
      [12,   "Chîcágö",  "Chîcágö",  "Chîcágö",  "Chîcágö",  "Chîcágö"],
      [13,   0.0,        0.0,        0.0,        0.0,        False],
      [14,   1.0,        1.0,        1.0,        1.0,        True],
      [15,   1509556595, 1509556595, 1509556595, 1509556595, 1509556595],
      [16,   8.153,      8.153,      8.153,      8.153,      8.153],
      [17,   0.0,        0.0,        0.0,        0.0,        0],
      [18,   1.0,        1.0,        1.0,        1.0,        1],
      [19,   None,       None,       None,       None,        ""],
      [20,   None,       None,       None,       None,       None]
    ])

  def test_numerics_are_floats(self):
    """
    Tests that in formulas, numeric values are floats, not integers.
    Important to avoid truncation.
    """
    self.load_sample(self.sample)
    self.assertTableData('Formulas', data=[
      ['id', 'division'],
      [ 1,   0.5],
    ])
